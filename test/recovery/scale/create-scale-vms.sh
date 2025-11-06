#!/bin/bash

# Script to create 120 Ubuntu VMs for scale testing with specific configuration
# VMs will have:
# - Ubuntu 22.04 LTS
# - Tag 'smcp-backup' = 'on'
# - No public IP
# - No NSG (Network Security Group)
# - VM Size: Standard_B2ls_v2

set -e  # Exit on any error

# Load environment variables if .env exists
if [ -f .env ]; then
    set -a && source .env && set +a
fi

# Configuration variables
VM_COUNT=${VM_COUNT:-120}
VM_SIZE=${VM_SIZE:-"Standard_B2ls_v2"}
VM_PREFIX=${VM_PREFIX:-"scale-test-vm"}
RESOURCE_GROUP=${RESOURCE_GROUP:-"scale-test-rg"}
LOCATION=${LOCATION:-"eastus"}
VNET_NAME=${VNET_NAME:-"scale-test-vnet"}
SUBNET_NAME=${SUBNET_NAME:-"default"}
ADMIN_USERNAME=${ADMIN_USERNAME:-"azureuser"}
SSH_KEY_PATH=${SSH_KEY_PATH:-"$HOME/.ssh/id_rsa.pub"}

# Ubuntu Image details
IMAGE_PUBLISHER="Canonical"
IMAGE_OFFER="0001-com-ubuntu-server-jammy"
IMAGE_SKU="22_04-lts-gen2"
IMAGE_VERSION="latest"

# Batch size for parallel processing
BATCH_SIZE=${BATCH_SIZE:-10}

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Function to check prerequisites
check_prerequisites() {
    print_status "Checking prerequisites..."
    
    # Check if Azure CLI is installed and logged in
    if ! az account show > /dev/null 2>&1; then
        print_error "Azure CLI not logged in. Please run 'az login'"
        exit 1
    fi
    
    # Check if SSH key exists
    if [[ ! -f "$SSH_KEY_PATH" ]]; then
        print_warning "SSH public key not found at $SSH_KEY_PATH"
        print_status "Generating SSH key pair..."
        ssh-keygen -t rsa -b 4096 -f "${SSH_KEY_PATH%.*}" -N "" -C "scale-test@$(hostname)"
    fi
    
    print_success "Prerequisites checked"
}

# Function to create resource group if it doesn't exist
create_resource_group() {
    print_status "Checking resource group: $RESOURCE_GROUP"
    
    if ! az group show --name "$RESOURCE_GROUP" > /dev/null 2>&1; then
        print_status "Creating resource group: $RESOURCE_GROUP"
        az group create --name "$RESOURCE_GROUP" --location "$LOCATION"
        print_success "Resource group created"
    else
        print_status "Resource group already exists"
    fi
}

# Function to create virtual network and subnet
create_network() {
    print_status "Setting up network infrastructure..."
    
    # Create VNet if it doesn't exist
    if ! az network vnet show --resource-group "$RESOURCE_GROUP" --name "$VNET_NAME" > /dev/null 2>&1; then
        print_status "Creating virtual network: $VNET_NAME"
        az network vnet create \
            --resource-group "$RESOURCE_GROUP" \
            --name "$VNET_NAME" \
            --address-prefix "10.0.0.0/16" \
            --subnet-name "$SUBNET_NAME" \
            --subnet-prefix "10.0.1.0/24" \
            --location "$LOCATION"
        print_success "Virtual network created"
    else
        print_status "Virtual network already exists"
        
        # Check if subnet exists
        if ! az network vnet subnet show --resource-group "$RESOURCE_GROUP" --vnet-name "$VNET_NAME" --name "$SUBNET_NAME" > /dev/null 2>&1; then
            print_status "Creating subnet: $SUBNET_NAME"
            az network vnet subnet create \
                --resource-group "$RESOURCE_GROUP" \
                --vnet-name "$VNET_NAME" \
                --name "$SUBNET_NAME" \
                --address-prefix "10.0.1.0/24"
            print_success "Subnet created"
        else
            print_status "Subnet already exists"
        fi
    fi
}

# Function to create a single VM
create_vm() {
    local vm_number=$1
    local vm_name="${VM_PREFIX}-$(printf "%03d" $vm_number)"
    local nic_name="${vm_name}-nic"
    
    print_status "Creating VM: $vm_name (${vm_number}/${VM_COUNT})"
    
    # Create network interface without public IP and NSG
    az network nic create \
        --resource-group "$RESOURCE_GROUP" \
        --name "$nic_name" \
        --vnet-name "$VNET_NAME" \
        --subnet "$SUBNET_NAME" \
        --location "$LOCATION" \
        --tags "smcp-backup=on" "purpose=scale-test" \
        --output none
    
    # Create virtual machine
    az vm create \
        --resource-group "$RESOURCE_GROUP" \
        --name "$vm_name" \
        --location "$LOCATION" \
        --size "$VM_SIZE" \
        --image "${IMAGE_PUBLISHER}:${IMAGE_OFFER}:${IMAGE_SKU}:${IMAGE_VERSION}" \
        --storage-sku Standard_LRS \
        --admin-username "$ADMIN_USERNAME" \
        --ssh-key-values "$SSH_KEY_PATH" \
        --nics "$nic_name" \
        --tags "smcp-backup=on" "purpose=scale-test" "vm-number=$vm_number" \
        --output none
    
    if [ $? -eq 0 ]; then
        print_success "✅ VM created: $vm_name"
        return 0
    else
        print_error "❌ Failed to create VM: $vm_name"
        return 1
    fi
}

# Function to create VMs in batches
create_vms_batch() {
    local start=$1
    local end=$2
    local batch_num=$3
    
    print_status "Creating batch $batch_num: VMs $start to $end"
    
    local pids=()
    local success_count=0
    local failed_count=0
    
    # Create VMs in parallel within this batch
    for i in $(seq $start $end); do
        create_vm $i &
        pids+=($!)
    done
    
    # Wait for all VMs in this batch to complete
    for pid in "${pids[@]}"; do
        if wait $pid; then
            ((success_count++))
        else
            ((failed_count++))
        fi
    done
    
    print_status "Batch $batch_num completed: $success_count successful, $failed_count failed"
    return $failed_count
}

# Function to create all VMs
create_all_vms() {
    print_status "Creating $VM_COUNT VMs in batches of $BATCH_SIZE..."
    
    local total_success=0
    local total_failed=0
    local batch_num=1
    
    for start in $(seq 1 $BATCH_SIZE $VM_COUNT); do
        local end=$((start + BATCH_SIZE - 1))
        if [ $end -gt $VM_COUNT ]; then
            end=$VM_COUNT
        fi
        
        if create_vms_batch $start $end $batch_num; then
            local batch_success=$((end - start + 1))
            total_success=$((total_success + batch_success))
        else
            local batch_failed=$?
            local batch_success=$((end - start + 1 - batch_failed))
            total_success=$((total_success + batch_success))
            total_failed=$((total_failed + batch_failed))
        fi
        
        batch_num=$((batch_num + 1))
        
        # Small delay between batches to avoid rate limiting
        if [ $end -lt $VM_COUNT ]; then
            print_status "Waiting 30 seconds before next batch..."
            sleep 30
        fi
    done
    
    print_success "VM creation completed: $total_success successful, $total_failed failed out of $VM_COUNT total"
}

# Function to list created VMs
list_created_vms() {
    print_status "Listing created VMs with smcp-backup tag..."
    
    az vm list \
        --resource-group "$RESOURCE_GROUP" \
        --query "[?tags.\"smcp-backup\" == 'on'].{Name:name, Size:hardwareProfile.vmSize, Status:provisioningState, Tags:tags}" \
        --output table
}

# Function to show summary
show_summary() {
    local vm_count=$(az vm list --resource-group "$RESOURCE_GROUP" --query "[?tags.\"smcp-backup\" == 'on']" --query "length(@)")
    
    print_success "======================================="
    print_success "Scale Test VM Creation Summary"
    print_success "======================================="
    print_success "VMs Created: $vm_count"
    print_success "VM Size: $VM_SIZE"
    print_success "Image: Ubuntu 22.04 LTS"
    print_success "Tag: smcp-backup=on"
    print_success "Network: No public IP, no NSG"
    print_success "Resource Group: $RESOURCE_GROUP"
    print_success "Location: $LOCATION"
    print_success "======================================="
}

# Function to cleanup (optional)
cleanup_vms() {
    print_warning "This will DELETE ALL VMs with tag smcp-backup=on in resource group $RESOURCE_GROUP"
    read -p "Are you sure? (yes/no): " confirm
    
    if [ "$confirm" == "yes" ]; then
        print_status "Deleting VMs..."
        
        # Get list of VMs with the tag
        vm_names=$(az vm list \
            --resource-group "$RESOURCE_GROUP" \
            --query "[?tags.\"smcp-backup\" == 'on'].name" \
            --output tsv)
        
        if [ -n "$vm_names" ]; then
            for vm_name in $vm_names; do
                print_status "Deleting VM: $vm_name"
                az vm delete \
                    --resource-group "$RESOURCE_GROUP" \
                    --name "$vm_name" \
                    --yes \
                    --force-deletion &
            done
            wait
            print_success "VM deletion completed"
        else
            print_status "No VMs found with smcp-backup tag"
        fi
    else
        print_status "Cleanup cancelled"
    fi
}

# Main function
main() {
    print_status "Ubuntu VM Scale Test Creator"
    print_status "============================="
    print_status "Configuration:"
    print_status "  VM Count: $VM_COUNT"
    print_status "  VM Size: $VM_SIZE"
    print_status "  VM Prefix: $VM_PREFIX"
    print_status "  Resource Group: $RESOURCE_GROUP"
    print_status "  Location: $LOCATION"
    print_status "  VNet: $VNET_NAME"
    print_status "  Subnet: $SUBNET_NAME"
    print_status "  Batch Size: $BATCH_SIZE"
    print_status "  SSH Key: $SSH_KEY_PATH"
    echo ""
    
    # Check what action to perform
    case "${1:-create}" in
        "create")
            check_prerequisites
            create_resource_group
            create_network
            create_all_vms
            list_created_vms
            show_summary
            ;;
        "list")
            list_created_vms
            show_summary
            ;;
        "cleanup")
            cleanup_vms
            ;;
        *)
            echo "Usage: $0 [create|list|cleanup]"
            echo "  create  - Create the VMs (default)"
            echo "  list    - List existing VMs"
            echo "  cleanup - Delete all VMs with smcp-backup tag"
            exit 1
            ;;
    esac
}

# Execute main function with all arguments
main "$@"