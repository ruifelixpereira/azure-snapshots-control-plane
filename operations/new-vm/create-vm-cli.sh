#!/bin/bash

# This script provides a CLI interface to manage Azure VMs and snapshots.

# Exit immediately if any command fails (returns a non-zero exit code), preventing further execution.
set -e

# Logging functions
# These functions log messages with different severity levels (info, warn, error, debug).
log_info()    { echo "[INFO ] $(date '+%Y-%m-%d %H:%M:%S') $*"; }
log_warn()    { echo "[WARN ] $(date '+%Y-%m-%d %H:%M:%S') $*" >&2; }
log_error()   { echo "[ERROR] $(date '+%Y-%m-%d %H:%M:%S') $*" >&2; }
log_debug()   { [ "$DEBUG" = "1" ] && echo "[DEBUG] $(date '+%Y-%m-%d %H:%M:%S') $*"; }

# Function to get a VM metadata
get_vm_metadata() {

    local vmName=$1
    local resourceGroup=$2

    ## Validate parameters
    if [ -z "$resourceGroup" ] || [ -z "$vmName" ]; then
        echo "Usage: $0 --operation get-vm-metadata --vm-name <VM_NAME> --resource-group <RESOURCE_GROUP>"
        exit 1
    fi

    # Get VM metadata
    VM_METADATA=$(az vm show --name "$vmName" --resource-group "$resourceGroup" --query "{vmSize:hardwareProfile.vmSize, location:location, osDiskName:storageProfile.osDisk.name, osDiskId:storageProfile.osDisk.managedDisk.id, nicId:networkProfile.networkInterfaces[0].id}" -o json)
    VM_SIZE=$(echo "$VM_METADATA" | jq -r '.vmSize')
    DISK_NAME=$(echo "$VM_METADATA" | jq -r '.osDiskName')
    DISK_ID=$(echo "$VM_METADATA" | jq -r '.osDiskId')
    LOCATION=$(echo "$VM_METADATA" | jq -r '.location')

    # Get disk metadata
    DISK_METADATA=$(az disk show --name "$DISK_NAME" --resource-group "$resourceGroup" --query "{name:name, resourceGroup:resourceGroup, sku:sku.name, diskSizeGB:diskSizeGB}" -o json)
    DISK_SKU=$(echo "$DISK_METADATA" | jq -r '.sku')
    DISK_SIZE=$(echo "$DISK_METADATA" | jq -r '.diskSizeGB')

    # Get network metadata
    NIC_ID=$(echo "$VM_METADATA" | jq -r '.nicId')
    # Get subnet ID from NIC
    SUBNET_ID=$(az network nic show --ids "$NIC_ID" --query "ipConfigurations[0].subnet.id" -o tsv)

    echo "{\"vmName\": \"$vmName\", \"resourceGroup\": \"$resourceGroup\", \"location\": \"$LOCATION\", \"vmSize\": \"$VM_SIZE\", \"diskId\": \"$DISK_ID\", \"diskSku\": \"$DISK_SKU\", \"diskSizeGB\": \"$DISK_SIZE\", \"subnetId\": \"$SUBNET_ID\"}"
}

# Function to create a VM from a snapshot
create_vm_from_snapshot() {

    local vmName=$1
    local resourceGroup=$2
    local snapshotName=$3
    local vmSize=$4
    local diskSku=$5
    local subnetId=$6
    local privateIpAddress=$7

    ## Validate parameters
    if [ -z "$resourceGroup" ] || [ -z "$vmName" ] || [ -z "$snapshotName" ] || [ -z "$vmSize" ] || [ -z "$diskSku" ] || [ -z "$subnetId" ] || [ -z "$privateIpAddress" ]; then
        echo "Usage: create_vm_from_snapshot <VM_NAME> <RESOURCE_GROUP> <SNAPSHOT_NAME> <VM_SIZE> <DISK_SKU> <SUBNET_ID> <PRIVATE_IP_ADDRESS>"
        exit 1
    fi

    log_info "*** Creating VM '$vmName' from snapshot '$snapshotName'... ***"

    # Get snapshot location to created disk + vm in the same region
    LOCATION=$(az snapshot show --name "$snapshotName" --resource-group "$resourceGroup" --query "location" -o tsv)

    ## Validate subnet location
    # Extract the VNet resource group and VNet name from the subnet ID
    VNET_RG=$(echo "$subnetId" | awk -F'/' '{for(i=1;i<=NF;i++){if($i=="resourceGroups"){print $(i+1)}}}')
    VNET_NAME=$(echo "$subnetId" | awk -F'/' '{for(i=1;i<=NF;i++){if($i=="virtualNetworks"){print $(i+1)}}}')

    # Get the VNet location
    VNET_LOCATION=$(az network vnet show --resource-group "$VNET_RG" --name "$VNET_NAME" --query "location" -o tsv)

    if [ "$VNET_LOCATION" != "$LOCATION" ]; then
        log_error "Subnet is in location '$VNET_LOCATION', but expected '$LOCATION'."
        exit 1
    fi

    # Create a managed disk from the snapshot
    az disk create --resource-group "$resourceGroup" --name "${vmName}_osdisk" --source "$snapshotName" --location "$LOCATION" --sku "$diskSku" --tag "smcp-creation=recovery"

    # Create the VM using the managed disk
    az vm create \
      --resource-group "$resourceGroup" \
      --name "$vmName" \
      --attach-os-disk "${vmName}_osdisk" \
      --os-type linux \
      --location "$LOCATION" \
      --subnet "$subnetId" \
      --private-ip-address "$privateIpAddress" \
      --public-ip-address "" \
      --nsg "" \
      --size "$vmSize" \
      --tag "smcp-creation=recovery"

    # Enable boot diagnostics
    az vm boot-diagnostics enable \
        --name "$vmName" \
        --resource-group "$resourceGroup"

    log_info "*** Completed creating VM '$vmName' from snapshot '$snapshotName'... ***"
}


# Function to create a VM from a snapshot
create_vm() {

    create_vm_start_date=$(date +%s)

    ## Validate parameters
    if [ -z "$RESOURCE_GROUP" ] || [ -z "$NEW_VM_NAME" ] || [ -z "$ORIGINAL_VM_NAME" ] || [ -z "$NEW_IP" ]; then
        echo "Usage: $0 --new-vm-name <NEW_VM_NAME> --resource-group <RESOURCE_GROUP> --original-vm-name <ORIGINAL_VM_NAME> --new-ip <NEW_IP>"
        exit 1
    fi

    log_info "--- Creating new VM '$NEW_VM_NAME' from original VM '$ORIGINAL_VM_NAME'... ---"

    # Get info from original VM
    VM_INFO=$(get_vm_metadata "$ORIGINAL_VM_NAME" "$RESOURCE_GROUP")

    VM_SIZE=$(echo "$VM_INFO" | jq -r '.vmSize')
    DISK_SKU=$(echo "$VM_INFO" | jq -r '.diskSku')
    SUBNET_ID=$(echo "$VM_INFO" | jq -r '.subnetId')
    ORIGINAL_VM_DISK_ID=$(echo "$VM_INFO" | jq -r '.diskId')
    ORIGINAL_LOCATION=$(echo "$VM_INFO" | jq -r '.location')

    # Create snapshot from original VM
    SNAPSHOT_NAME="${ORIGINAL_VM_NAME}_snapshot_$(date +%Y%m%d%H%M%S)"
    log_info "--- Creating snapshot '$SNAPSHOT_NAME' from original VM Disk '$ORIGINAL_VM_DISK_ID'... ---"
    az snapshot create --name $SNAPSHOT_NAME --resource-group $RESOURCE_GROUP --source $ORIGINAL_VM_DISK_ID --sku "Standard_LRS" --incremental false --location $ORIGINAL_LOCATION

    # Create vm from snapshot
    create_vm_from_snapshot "$NEW_VM_NAME" "$RESOURCE_GROUP" "$SNAPSHOT_NAME" "$VM_SIZE" "$DISK_SKU" "$SUBNET_ID" "$NEW_IP"

    # Duration calculation
    create_vm_end_date=$(date +%s)
    create_vm_elapsed=$((create_vm_end_date - create_vm_start_date))
    create_vm_minutes=$((create_vm_elapsed / 60))
    create_vm_seconds=$((create_vm_elapsed % 60))

    log_info "--- Completed creating VM '$VM_NAME' from snapshot '$SNAPSHOT_NAME' in ${create_vm_minutes} minutes and ${create_vm_seconds} seconds. ---"
}

print_help() {
    echo "Usage: $0 --new-vm-name <NEW_VM_NAME> --resource-group <RESOURCE_GROUP> --original-vm-name <ORIGINAL_VM_NAME> --new-ip <NEW_IP>"
}

# Parse command-line arguments
while [[ "$#" -gt 0 ]]; do
    case $1 in
        --resource-group) RESOURCE_GROUP="$2"; shift ;;
        --new-vm-name) NEW_VM_NAME="$2"; shift ;;
        --original-vm-name) ORIGINAL_VM_NAME="$2"; shift ;;
        --new-ip) NEW_IP="$2"; shift ;;
        --help) print_help; exit 0 ;;
        *) echo "Unknown parameter passed: $1"; exit 1 ;;
    esac
    shift
done

create_vm
