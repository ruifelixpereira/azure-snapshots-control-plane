#!/bin/bash

# This script provides a CLI interface to manage Azure VMs and snapshots.

# Exit immediately if any command fails (returns a non-zero exit code), preventing further execution.
set -e

# Metadata file name
METADATA_FILE="reference.json"

# Logging functions
# These functions log messages with different severity levels (info, warn, error, debug).
log_info()    { echo "[INFO ] $(date '+%Y-%m-%d %H:%M:%S') $*"; }
log_warn()    { echo "[WARN ] $(date '+%Y-%m-%d %H:%M:%S') $*" >&2; }
log_error()   { echo "[ERROR] $(date '+%Y-%m-%d %H:%M:%S') $*" >&2; }
log_debug()   { [ "$DEBUG" = "1" ] && echo "[DEBUG] $(date '+%Y-%m-%d %H:%M:%S') $*"; }

# Map T-shirt size to disk SKU and VM size
get_sku_for_tshirt_size() {
    local tshirt_size=$(echo "$1" | tr '[:lower:]' '[:upper:]')
    local map_file="${METADATA_FILE:-reference.json}"

    if [ ! -f "$map_file" ]; then
        log_error "T-shirt SKU map file '$map_file' not found!"
        exit 1
    fi

    DISK_SKU=$(jq -r --arg size "$tshirt_size" '.[$size].diskSku // empty' "$map_file")
    VM_SIZE=$(jq -r --arg size "$tshirt_size" '.[$size].vmSize // empty' "$map_file")
    SNAPSHOT_NAME=$(jq -r --arg size "$tshirt_size" '.[$size].snapshotName // empty' "$map_file")

    if [ -z "$DISK_SKU" ] || [ -z "$VM_SIZE" ]; then
        log_error "Unknown T-shirt size: $tshirt_size"
        exit 1
    fi
}


# Function to create a VM from a snapshot
create_vm_from_snapshot() {

    local vmName=$1
    local resourceGroup=$2
    local snapshotName=$3
    local vmSize=$4
    local diskSku=$5
    local subnetId=$6

    ## Validate parameters
    if [ -z "$resourceGroup" ] || [ -z "$vmName" ] || [ -z "$snapshotName" ] || [ -z "$vmSize" ] || [ -z "$diskSku" ] || [ -z "$subnetId" ]; then
        echo "Usage: create_vm_from_snapshot <VM_NAME> <RESOURCE_GROUP> <SNAPSHOT_NAME> <VM_SIZE> <DISK_SKU> <SUBNET_ID>"
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
    if [ -z "$RESOURCE_GROUP" ] || [ -z "$VM_NAME" ] || [ -z "$TSHIRT_SIZE" ] || [ -z "$SUBNET_ID" ]; then
        echo "Usage: $0 --vm-name <VM_NAME> --resource-group <RESOURCE_GROUP> --tshirt-size <TSHIRT_SIZE> --subnet-id <SUBNET_ID>"
        exit 1
    fi

    log_info "--- Creating VM '$VM_NAME' from snapshot '$SNAPSHOT_NAME'... ---"

    # Map T-shirt size to SKUs
    get_sku_for_tshirt_size "$TSHIRT_SIZE"

    # Create vm from snapshot
    create_vm_from_snapshot "$VM_NAME" "$RESOURCE_GROUP" "$SNAPSHOT_NAME" "$VM_SIZE" "$DISK_SKU" "$SUBNET_ID"

    # Duration calculation
    create_vm_end_date=$(date +%s)
    create_vm_elapsed=$((create_vm_end_date - create_vm_start_date))
    create_vm_minutes=$((create_vm_elapsed / 60))
    create_vm_seconds=$((create_vm_elapsed % 60))

    log_info "--- Completed creating VM '$VM_NAME' from snapshot '$SNAPSHOT_NAME' in ${create_vm_minutes} minutes and ${create_vm_seconds} seconds. ---"
}


print_help() {
    echo "Usage: $0 --vm-name <VM_NAME> --resource-group <RESOURCE_GROUP> --tshirt-size <TSHIRT_SIZE> --subnet-id <SUBNET_ID>"
}

# Parse command-line arguments
while [[ "$#" -gt 0 ]]; do
    case $1 in
        --resource-group) RESOURCE_GROUP="$2"; shift ;;
        --subnet-id) SUBNET_ID="$2"; shift ;;
        --vm-name) VM_NAME="$2"; shift ;;
        --tshirt-size) TSHIRT_SIZE="$2"; shift ;;
        --help) print_help; exit 0 ;;
        *) echo "Unknown parameter passed: $1"; exit 1 ;;
    esac
    shift
done

create_vm
