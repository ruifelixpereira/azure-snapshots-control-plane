#!/bin/bash

# This script provides a CLI interface to manage Azure VMs and snapshots.

# Exit immediately if any command fails (returns a non-zero exit code), preventing further execution.
set -e

# Metadata file name
DEFAULT_METADATA_FILE="recovery-metadata.json"

# T-shirt size to SKU mapping file
T_SHIRT_MAP_FILE="tshirt-map.json"

# Logging functions
# These functions log messages with different severity levels (info, warn, error, debug).
log_info()    { echo "[INFO ] $(date '+%Y-%m-%d %H:%M:%S') $*"; }
log_warn()    { echo "[WARN ] $(date '+%Y-%m-%d %H:%M:%S') $*" >&2; }
log_error()   { echo "[ERROR] $(date '+%Y-%m-%d %H:%M:%S') $*" >&2; }
log_debug()   { [ "$DEBUG" = "1" ] && echo "[DEBUG] $(date '+%Y-%m-%d %H:%M:%S') $*"; }

# Map T-shirt size to disk SKU and VM size
get_sku_for_tshirt_size() {
    local tshirt_size=$(echo "$1" | tr '[:lower:]' '[:upper:]')
    local map_file="${T_SHIRT_MAP_FILE:-tshirt-map.json}"

    if [ ! -f "$map_file" ]; then
        log_error "T-shirt SKU map file '$map_file' not found!"
        exit 1
    fi

    DISK_SKU=$(jq -r --arg size "$tshirt_size" '.[$size].diskSku // empty' "$map_file")
    VM_SIZE=$(jq -r --arg size "$tshirt_size" '.[$size].vmSize // empty' "$map_file")

    if [ -z "$DISK_SKU" ] || [ -z "$VM_SIZE" ]; then
        log_error "Unknown T-shirt size: $tshirt_size"
        exit 1
    fi
}

# Function to list all VMs including the backup protection state
list_all_vms() {
    log_info "--- Listing all VMs including the backup protection state (on/off)... ---"
    echo -e "VmName\tResourceGroup\tBackup"
    az vm list --show-details --output json | jq -r '.[] | [.name, .resourceGroup, (.tags["smcp-backup"] // "off")] | @tsv'
}

# Function to list VMs with backup protection state 'on'
list_protected_vms() {
    log_info "--- Listing VMs with active backup protection tag 'smcp-backup=on'... ---"
    echo -e "VmName\tResourceGroup\tLocation"
    az vm list --output json | jq -r '.[] | select(.tags["smcp-backup"] == "on") | [.name, .resourceGroup, .location] | @tsv'
}

# Function to list all snapshots for vm
list_vm_snapshots() {

    ## Validate parameters
    if [ -z "$RESOURCE_GROUP" ] || [ -z "$VM_NAME" ]; then
        echo "Usage: $0 --operation list-vm-snapshots --vm-name <VM_NAME> --resource-group <RESOURCE_GROUP>"
        exit 1
    fi

    log_info "--- Listing all snapshots for vm name '$VM_NAME' in the resource group '$RESOURCE_GROUP'... ---"

    # Get the disk name associated with the VM
    DISK_NAME=$(az vm show --name "$VM_NAME" --resource-group "$RESOURCE_GROUP" --query "storageProfile.osDisk.name" -o tsv)
    
    # Print header row
    echo -e "SnapshotName\tResourceGroup\tLocation"

    # List snapshots
    az snapshot list --query "[?contains(name, '$DISK_NAME')].[name, resourceGroup, location]" -o tsv
}

# Function to export metadata for all VMs with active backup protection (including snapshots available) in JSON format
export_metadata() {
    log_info "--- Exporting metadata for all VMs with active backup protection (including snapshots available) in JSON format... ---"

    local outputMetadataFile=$CUSTOM_METADATA_FILE

    ## Validate parameters
    if [ -z "$outputMetadataFile" ]; then
        # Use the default name"
        outputMetadataFile="$DEFAULT_METADATA_FILE"
    fi

    # Get VM metadata
    #VMS=$(az vm list --query "[].{name:name, resourceGroup:resourceGroup, vmSize:hardwareProfile.vmSize}" -o json)
    VMS=$(az vm list --output json | jq '[.[] | select(.tags["smcp-backup"] == "on") | {name, resourceGroup, vmSize: .hardwareProfile.vmSize}]')
    echo "[" > $outputMetadataFile
    first=true
    echo "$VMS" | jq -c '.[]' | while read vm; do
        VM_NAME=$(echo "$vm" | jq -r '.name')
        RESOURCE_GROUP=$(echo "$vm" | jq -r '.resourceGroup')
        VM_SIZE=$(echo "$vm" | jq -r '.vmSize')

        # Get disk metadata
        DISK_NAME=$(az vm show --name "$VM_NAME" --resource-group "$RESOURCE_GROUP" --query "storageProfile.osDisk.name" -o tsv)
        DISK_METADATA=$(az disk show --name "$DISK_NAME" --resource-group "$RESOURCE_GROUP" --query "{name:name, resourceGroup:resourceGroup, sku:sku.name, diskSizeGB:diskSizeGB}" -o json)
        DISK_SKU=$(echo "$DISK_METADATA" | jq -r '.sku')
        DISK_SIZE=$(echo "$DISK_METADATA" | jq -r '.diskSizeGB')

        # Get Snapshots metdata
        #SNAPSHOTS=$(az snapshot list --query "[?contains(name, '$DISK_NAME')].[name, resourceGroup, location]" -o json)
        SNAPSHOTS=$(az snapshot list --query "[?contains(name, '$DISK_NAME')].{name:name, resourceGroup:resourceGroup, location:location}" -o json)
        if [ "$first" = true ]; then
            first=false
        else
            echo "," >> $outputMetadataFile
        fi
        echo "{\"vmName\": \"$VM_NAME\", \"resourceGroup\": \"$RESOURCE_GROUP\", \"vmSize\": \"$VM_SIZE\", \"diskSku\": \"$DISK_SKU\", \"diskSizeGB\": \"$DISK_SIZE\", \"snapshots\": $SNAPSHOTS}" >> $outputMetadataFile
    done
    echo "]" >> $outputMetadataFile
    log_info "--- Snapshots exported to $outputMetadataFile ---"
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

    ## Validate parameters
    if [ -z "$RESOURCE_GROUP" ] || [ -z "$VM_NAME" ] || [ -z "$SNAPSHOT_NAME" ] || [ -z "$TSHIRT_SIZE" ] || [ -z "$SUBNET_ID" ]; then
        echo "Usage: $0 --operation create-vm --vm-name <VM_NAME> --resource-group <RESOURCE_GROUP> --snapshot-name <SNAPSHOT_NAME> --tshirt-size <TSHIRT_SIZE> --subnet-id <SUBNET_ID>"
        exit 1
    fi

    log_info "--- Creating VM '$VM_NAME' from snapshot '$SNAPSHOT_NAME'... ---"

    # Map T-shirt size to SKUs
    get_sku_for_tshirt_size "$TSHIRT_SIZE"

    # Create vm from snapshot
    create_vm_from_snapshot "$VM_NAME" "$RESOURCE_GROUP" "$SNAPSHOT_NAME" "$VM_SIZE" "$DISK_SKU" "$SUBNET_ID"

    log_info "--- Completed creating VM '$VM_NAME' from snapshot '$SNAPSHOT_NAME'... ---"
}

# Creates a VM using the information in the metadata file and using the most recent snaphsot in the metadata file
# This function assumes that the metadata file contains the necessary information to create the VM.
restore_vm() {

    ## Validate parameters
    if [ -z "$ORIGINAL_VM_NAME" ] || [ -z "$SUBNET_ID" ]; then
        echo "Usage: $0 --operation restore-vm original-vm-name <ORIGINAL_VM_NAME> --subnet-id <SUBNET_ID> [--custom-metadata-file <CUSTOM_METADATA_FILE>]"
        exit 1
    fi

    # Get which metadata file to use (custom or default)
    # Check if overriding custom metadata parameter was provided
    local referenceMetadataFile=$CUSTOM_METADATA_FILE

    if [ -z "$referenceMetadataFile" ]; then
        # Use the default name"
        referenceMetadataFile="$DEFAULT_METADATA_FILE"

        if [ ! -f $referenceMetadataFile ]; then
            # Generate metadata
            export_metadata
        fi
    fi

    # Check if metadata file exists
    if [ ! -f $referenceMetadataFile ]; then
        log_error "Reference metadata file '$referenceMetadataFile' not found!"
        exit 1
    fi

    log_info "--- Creating clone from original VM '$ORIGINAL_VM_NAME' using the last snapshot from metadata... ---"

    # Get VM info from metadata
    VM_INFO=$(jq -c --arg vm "$ORIGINAL_VM_NAME" '.[] | select(.vmName == $vm)' $referenceMetadataFile)
    RESOURCE_GROUP=$(echo "$VM_INFO" | jq -r -c '.resourceGroup')
    VM_SIZE=$(echo "$VM_INFO" | jq -r -c '.vmSize')
    DISK_SKU=$(echo "$VM_INFO" | jq -r -c '.diskSku')

    # Get all snapshots for VM
    SNAPSHOTS_INFO=$(echo "$VM_INFO" | jq -c '.snapshots')

    # Get the most recent snapshot
    MOST_RECENT_SNAPSHOT=$(echo "$SNAPSHOTS_INFO" | jq -r '.[].name' | sort -r | head -n 1)
    if [ -z "$MOST_RECENT_SNAPSHOT" ]; then
        log_warn "No snapshots are available for VM '$ORIGINAL_VM_NAME'."
        exit 1
    fi

    # Create vm from snapshot
    UNIQUE_STR=$(tr -dc 'a-z0-9' </dev/urandom | head -c5)
    create_vm_from_snapshot $ORIGINAL_VM_NAME-$UNIQUE_STR $RESOURCE_GROUP $MOST_RECENT_SNAPSHOT $VM_SIZE $DISK_SKU $SUBNET_ID

    log_info "--- Completed creating clone from original VM '$ORIGINAL_VM_NAME' using the last snapshot from metadata... ---"
}


# Function to create group of VMs from most recent snapshots
restore_vm_group() {

    ## Validate parameters
    if [ -z "$ORIGINAL_VM_GROUP" ] || [ -z "$SUBNET_ID" ]; then
        echo "Usage: $0 --operation restore-vm-group --original-vm-group <ORIGINAL_VM_GROUP> --subnet-id <SUBNET_ID> [--custom-metadata-file <CUSTOM_METADATA_FILE>]"
        exit 1
    fi

    # Get which metadata file to use (custom or default)
    # Check if overriding custom metadata parameter was provided
    local referenceMetadataFile=$CUSTOM_METADATA_FILE

    if [ -z "$referenceMetadataFile" ]; then
        # Use the default name"
        referenceMetadataFile="$DEFAULT_METADATA_FILE"

        if [ ! -f $referenceMetadataFile ]; then
            # Generate metadata
            export_metadata
        fi
    fi

    # Check if metadata file exists
    if [ ! -f $referenceMetadataFile ]; then
        log_error "Reference metadata file '$referenceMetadataFile' not found!"
        exit 1
    fi

    log_info "--- Creating clones from original group of VMs '$ORIGINAL_VM_GROUP' using the last snapshots from metadata... ---"

    # Suppose VM_NAMES="vm1,vm2,vm3"
    IFS=',' read -r -a VM_NAMES_ARRAY <<< "$ORIGINAL_VM_GROUP"
    VM_NAMES_JSON=$(printf '%s\n' "${VM_NAMES_ARRAY[@]}" | jq -R . | jq -s .)

    # Array to hold PIDs
    PIDS=()

    while read -r vm_json; do
        # Extract VM information
        VM_NAME=$(echo "$vm_json" | jq -r '.vmName')
        RESOURCE_GROUP=$(echo "$vm_json" | jq -r '.resourceGroup')
        VM_SIZE=$(echo "$vm_json" | jq -r '.vmSize')
        DISK_SKU=$(echo "$vm_json" | jq -r '.diskSku')

        # Get all snapshots for VM
        SNAPSHOTS_INFO=$(echo "$vm_json" | jq -c '.snapshots')

        # Get the most recent snapshot
        MOST_RECENT_SNAPSHOT=$(echo "$SNAPSHOTS_INFO" | jq -r '.[].name' | sort -r | head -n 1)
        if [ -z "$MOST_RECENT_SNAPSHOT" ]; then
            log_warn "No snapshots are available for VM '$VM_NAME'."
            continue
        fi

        # Create vm from snapshot
        UNIQUE_STR=$(tr -dc 'a-z0-9' </dev/urandom | head -c5)

        # Launch in background and collect PID
        log_info "=== Launching parallel process to create VM '$VM_NAME-$UNIQUE_STR' from snapshot '$MOST_RECENT_SNAPSHOT'... ==="
        create_vm_from_snapshot $VM_NAME-$UNIQUE_STR $RESOURCE_GROUP $MOST_RECENT_SNAPSHOT $VM_SIZE $DISK_SKU $SUBNET_ID &
        PIDS+=($!)
    done < <(jq --argjson names "$VM_NAMES_JSON" -c '[.[] | select(.vmName | IN($names[]))][]' "$referenceMetadataFile")

    # Wait for all background jobs to finish
    for pid in "${PIDS[@]}"; do
        wait "$pid"
    done

    log_info "--- Completed creating clones from original group of VMs '$ORIGINAL_VM_GROUP' using the last snapshots from metadata... ---"
}

# Function to create all VMs from most recent snapshots
restore_all_vms() {

    ## Validate parameters
    if [ -z "$SUBNET_ID" ]; then
        echo "Usage: $0 --operation restore-all-vms --subnet-id <SUBNET_ID> [--custom-metadata-file <CUSTOM_METADATA_FILE>]"
        exit 1
    fi

    # Get which metadata file to use (custom or default)
    # Check if overriding custom metadata parameter was provided
    local referenceMetadataFile=$CUSTOM_METADATA_FILE

    if [ -z "$referenceMetadataFile" ]; then
        # Use the default name"
        referenceMetadataFile="$DEFAULT_METADATA_FILE"

        if [ ! -f $referenceMetadataFile ]; then
            # Generate metadata
            export_metadata
        fi
    fi

    # Check if metadata file exists
    if [ ! -f $referenceMetadataFile ]; then
        log_error "Reference metadata file '$referenceMetadataFile' not found!"
        exit 1
    fi

    log_info "--- Creating clones for all original VMs using the last snapshots from metadata... ---"

    # Array to hold PIDs
    PIDS=()

    while read -r vm_json; do
        # Extract VM information
        VM_NAME=$(echo "$vm_json" | jq -r '.vmName')
        RESOURCE_GROUP=$(echo "$vm_json" | jq -r '.resourceGroup')
        VM_SIZE=$(echo "$vm_json" | jq -r '.vmSize')
        DISK_SKU=$(echo "$vm_json" | jq -r '.diskSku')

        # Get all snapshots for VM
        SNAPSHOTS_INFO=$(echo "$vm_json" | jq -c '.snapshots')

        # Get the most recent snapshot
        MOST_RECENT_SNAPSHOT=$(echo "$SNAPSHOTS_INFO" | jq -r '.[].name' | sort -r | head -n 1)
        if [ -z "$MOST_RECENT_SNAPSHOT" ]; then
            log_warn "No snapshots are available for VM '$VM_NAME'."
            continue
        fi

        # Create vm from snapshot
        UNIQUE_STR=$(tr -dc 'a-z0-9' </dev/urandom | head -c5)

        # Launch in background and collect PID
        log_info "=== Launching parallel process to create VM '$VM_NAME-$UNIQUE_STR' from snapshot '$MOST_RECENT_SNAPSHOT'... ==="
        create_vm_from_snapshot $VM_NAME-$UNIQUE_STR $RESOURCE_GROUP $MOST_RECENT_SNAPSHOT $VM_SIZE $DISK_SKU $SUBNET_ID &
        PIDS+=($!)
    done < <(jq -c '[.[] ][]' "$referenceMetadataFile")

    # Wait for all background jobs to finish
    for pid in "${PIDS[@]}"; do
        wait "$pid"
    done

    log_info "--- Completed creating clones for all original VMs using the last snapshots from metadata... ---"
}


print_help() {
  echo "Usage: $0 --operation <operation> [parameters]"
  echo ""
  echo "Available operations:"
  echo "  --operation list-all-vms"
  echo "      Lists all VMs and their backup protection state."
  echo ""
  echo "  --operation list-protected-vms"
  echo "      Lists VMs protected with active backups (with the tag 'smcp-backup=on')."
  echo ""
  echo "  --operation list-vm-snapshots --vm-name <VM_NAME> --resource-group <RESOURCE_GROUP>"
  echo "      Lists snapshots for a specific VM."
  echo ""
  echo "  --operation export-metadata [--custom-metadata-file <CUSTOM_METADATA_FILE>]"
  echo "      Exports metadata for all VMs protected with active backups. If a custom metadata file name is not specified the default one is used."
  echo ""
  echo "  --operation create-vm --vm-name <VM_NAME> --resource-group <RESOURCE_GROUP> --snapshot-name <SNAPSHOT_NAME> --tshirt-size <TSHIRT_SIZE> --subnet-id <SUBNET_ID>"
  echo "      Creates a VM from a specified snapshot."
  echo ""
  echo "  --operation restore-vm --original-vm-name <ORIGINAL_VM_NAME> --subnet-id <SUBNET_ID> [--custom-metadata-file <CUSTOM_METADATA_FILE>]"
  echo "      Creates a VM from the most recent snapshot of the original VM in the metadata file. If a custom metadata file is not specified the default one is used."
  echo ""
  echo "  --operation restore-vm-group --original-vm-group <ORIGINAL_VM_GROUP> --subnet-id <SUBNET_ID> [--custom-metadata-file <CUSTOM_METADATA_FILE>]"
  echo "      Creates a group of VMs from the most recent snapshots of the original VMs in the metadata file. If a custom metadata file is not specified the default one is used."
  echo ""
  echo "  --operation restore-all-vms --subnet-id <SUBNET_ID> [--custom-metadata-file <CUSTOM_METADATA_FILE>]"
  echo "      Creates all VMs from the most recent snapshots of the original VMs in the metadata file. If a custom metadata file is not specified the default one is used."
  echo ""
  echo "  --help"
  echo "      Displays this help message."
}

# Parse command-line arguments
while [[ "$#" -gt 0 ]]; do
    case $1 in
        --operation) OPERATION="$2"; shift ;;
        --snapshot-name) SNAPSHOT_NAME="$2"; shift ;;
        --resource-group) RESOURCE_GROUP="$2"; shift ;;
        --subnet-id) SUBNET_ID="$2"; shift ;;
        --custom-metadata-file) CUSTOM_METADATA_FILE="$2"; shift ;;
        --vm-name) VM_NAME="$2"; shift ;;
        --original-vm-name) ORIGINAL_VM_NAME="$2"; shift ;;
        --original-vm-group) ORIGINAL_VM_GROUP="$2"; shift ;;
        --tshirt-size) TSHIRT_SIZE="$2"; shift ;;
        --help) print_help; exit 0 ;;
        *) echo "Unknown parameter passed: $1"; exit 1 ;;
    esac
    shift
done

# Interactive mode if no operation is provided
if [ -z "$OPERATION" ]; then
    print_help
else
    # Non-interactive mode
    case $OPERATION in
        help)
            print_help
            ;;
        list-all-vms)
            list_all_vms
            ;;
        list-protected-vms)
            list_protected_vms
            ;;
        list-vm-snapshots)
            list_vm_snapshots
            ;;
        export-metadata)
            export_metadata
            ;;
        create-vm)
            create_vm
            ;;
        restore-vm)
            restore_vm
            ;;
        restore-vm-group)
            restore_vm_group
            ;;
        restore-all-vms)
            restore_all_vms
            ;;
        *)
            log_error "Invalid operation: $OPERATION"
            ;;
    esac
fi
