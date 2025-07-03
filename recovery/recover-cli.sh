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
    VM_METADATA=$(az vm show --name "$vmName" --resource-group "$resourceGroup" --query "{vmSize:hardwareProfile.vmSize, osDiskName:storageProfile.osDisk.name}" -o json)
    VM_SIZE=$(echo "$VM_METADATA" | jq -r '.vmSize')
    DISK_NAME=$(echo "$VM_METADATA" | jq -r '.osDiskName')

    # Get disk metadata
    DISK_METADATA=$(az disk show --name "$DISK_NAME" --resource-group "$resourceGroup" --query "{name:name, resourceGroup:resourceGroup, sku:sku.name, diskSizeGB:diskSizeGB}" -o json)
    DISK_SKU=$(echo "$DISK_METADATA" | jq -r '.sku')
    DISK_SIZE=$(echo "$DISK_METADATA" | jq -r '.diskSizeGB')

    # Get list of snapshots
    SNAPSHOTS=$(az snapshot list --query "[?contains(name, '$DISK_NAME')].{name:name, resourceGroup:resourceGroup, location:location}" -o json)

    # Get the most recent snapshots
    MOST_RECENT_SECONDARY_SNAPSHOT=$(echo "$SNAPSHOTS" | jq -r -c 'sort_by(.name) | map(select(.name | endswith("-sec"))) | last // ""')
    MOST_RECENT_PRIMARY_SNAPSHOT=$(echo "$SNAPSHOTS" | jq -r -c 'sort_by(.name) | map(select(.name | endswith("-sec") | not)) | last // ""')

    # Format the output
    # Create a new JSON object
    #TEMP_VM_INFO=$(jq -n -r -c \
    #--arg vmName "$vmName" \
    #--arg resourceGroup "$resourceGroup" \
    #--arg vmSize "$VM_SIZE" \
    #--arg diskSku "$DISK_SKU" \
    #--arg diskSizeGB "$DISK_SIZE" \
    #--arg lastTemporarySnapshot "$MOST_RECENT_PRIMARY_SNAPSHOT" \
    #--arg lastBackupSnapshot "$MOST_RECENT_SECONDARY_SNAPSHOT" \
    #--argjson snapshots "$SNAPSHOTS" \
    #'{
    #    vmName: $vmName,
    #    resourceGroup: $resourceGroup,
    #    vmSize: $vmSize,
    #    diskSku: $diskSku,
    #    diskSizeGB: $diskSizeGB,
    #    lastTemporarySnapshot: $lastTemporarySnapshot,
    #    lastBackupSnapshot: $lastBackupSnapshot,
    #    snapshots: $snapshots
    #}')

    #echo "$TEMP_VM_INFO"

    echo "{\"vmName\": \"$vmName\", \"resourceGroup\": \"$resourceGroup\", \"vmSize\": \"$VM_SIZE\", \"diskSku\": \"$DISK_SKU\", \"diskSizeGB\": \"$DISK_SIZE\", \"lastTemporarySnapshot\": $MOST_RECENT_PRIMARY_SNAPSHOT, \"lastBackupSnapshot\": $MOST_RECENT_SECONDARY_SNAPSHOT, \"snapshots\": $SNAPSHOTS}"
}



# Function to export metadata for all VMs with active backup protection (including snapshots available) in JSON format
export_metadata() {

    export_metadata_start_date=$(date +%s)

    log_info "--- Exporting metadata for all VMs with active backup protection (including snapshots available) in JSON format... ---"

    local outputMetadataFile=$CUSTOM_METADATA_FILE

    ## Validate parameters
    if [ -z "$outputMetadataFile" ]; then
        # Use the default name"
        outputMetadataFile="$DEFAULT_METADATA_FILE"
    fi

    # Get VM metadata
    VMS=$(az vm list --output json | jq '[.[] | select(.tags["smcp-backup"] == "on") | {name, resourceGroup, vmSize: .hardwareProfile.vmSize}]')
    echo "[" > $outputMetadataFile
    first=true
    echo "$VMS" | jq -c '.[]' | while read vm; do
        VM_NAME=$(echo "$vm" | jq -r '.name')
        RESOURCE_GROUP=$(echo "$vm" | jq -r '.resourceGroup')

        VM_INFO=$(get_vm_metadata "$VM_NAME" "$RESOURCE_GROUP")
        
        if [ "$first" = true ]; then
            first=false
        else
            echo "," >> $outputMetadataFile
        fi

        echo "$VM_INFO" >> $outputMetadataFile
    done
    echo "]" >> $outputMetadataFile

    # Duration calculation
    export_metadata_end_date=$(date +%s)
    export_metadata_elapsed=$((export_metadata_end_date - export_metadata_start_date))
    export_metadata_minutes=$((export_metadata_elapsed / 60))
    export_metadata_seconds=$((export_metadata_elapsed % 60))

    log_info "--- Snapshots exported to $outputMetadataFile in ${export_metadata_minutes} minutes and ${export_metadata_seconds} seconds.---"
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
    if [ -z "$RESOURCE_GROUP" ] || [ -z "$VM_NAME" ] || [ -z "$SNAPSHOT_NAME" ] || [ -z "$TSHIRT_SIZE" ] || [ -z "$SUBNET_ID" ]; then
        echo "Usage: $0 --operation create-vm --vm-name <VM_NAME> --resource-group <RESOURCE_GROUP> --snapshot-name <SNAPSHOT_NAME> --tshirt-size <TSHIRT_SIZE> --subnet-id <SUBNET_ID>"
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

# Creates a VM using the information in the metadata file and using the most recent snaphsot in the metadata file
# This function assumes that the metadata file contains the necessary information to create the VM.
restore_vm() {

    restore_vm_start_date=$(date +%s)

    ## Validate parameters
    if [ -z "$RESOURCE_GROUP" ] || [ -z "$ORIGINAL_VM_NAME" ] || [ -z "$SUBNET_ID" ]; then
        echo "Usage: $0 --operation restore-vm --original-vm-name <ORIGINAL_VM_NAME> --resource-group <RESOURCE_GROUP> --subnet-id <SUBNET_ID> [--restore-primary-region] [--custom-metadata-file <CUSTOM_METADATA_FILE>]"
        exit 1
    fi

    if [ -z "$CUSTOM_METADATA_FILE" ]; then
        # No custom data
        VM_INFO=$(get_vm_metadata "$ORIGINAL_VM_NAME" "$RESOURCE_GROUP")
    else
        # Custom metadata file provided
        if [ ! -f "$CUSTOM_METADATA_FILE" ]; then
            log_error "Custom metadata file '$CUSTOM_METADATA_FILE' not found!"
            exit 1
        fi

        VM_INFO=$(jq -c --arg vm "$ORIGINAL_VM_NAME" '.[] | select(.vmName == $vm)' "$CUSTOM_METADATA_FILE")
    fi

    log_info "--- Creating clone from original VM '$ORIGINAL_VM_NAME' using the last snapshot from metadata... ---"

    # Get VM info from metadata
    VM_SIZE=$(echo "$VM_INFO" | jq -r '.vmSize')
    DISK_SKU=$(echo "$VM_INFO" | jq -r '.diskSku')

    # Get the most recent snapshot
    if [ "$RESTORE_TYPE" = "backup" ]; then
        # If RESTORE_TYPE is "backup", we want the last backup snapshot
        MOST_RECENT_SNAPSHOT=$(echo "$VM_INFO" | jq -c '.lastBackupSnapshot')
    else
        # If RESTORE_TYPE is "temporary", we want the last temporary snapshot
        MOST_RECENT_SNAPSHOT=$(echo "$VM_INFO" | jq -c '.lastTemporarySnapshot')
    fi

    if [ -z "$MOST_RECENT_SNAPSHOT" ]; then
        log_warn "No snapshots are available for VM '$ORIGINAL_VM_NAME'."
        exit 1
    fi

    SNAPSHOT_TO_USE=$(echo "$MOST_RECENT_SNAPSHOT" | jq -r -c '.name')

    # Create vm from snapshot
    UNIQUE_STR=$(tr -dc 'a-z0-9' </dev/urandom | head -c5)
    create_vm_from_snapshot $ORIGINAL_VM_NAME-$UNIQUE_STR $RESOURCE_GROUP $SNAPSHOT_TO_USE $VM_SIZE $DISK_SKU $SUBNET_ID

    # Duration calculation
    restore_vm_end_date=$(date +%s)
    restore_vm_elapsed=$((restore_vm_end_date - restore_vm_start_date))
    restore_vm_minutes=$((restore_vm_elapsed / 60))
    restore_vm_seconds=$((restore_vm_elapsed % 60))

    log_info "--- Completed creating clone from original VM '$ORIGINAL_VM_NAME' using the last snapshot from metadata in ${restore_vm_minutes} minutes and ${restore_vm_seconds} seconds. ---"
}


# Function to create group of VMs from most recent snapshots
restore_vm_group() {

    restore_vm_group_start_date=$(date +%s)

    ## Validate parameters
    if [ -z "$RESOURCE_GROUP" ] || [ -z "$ORIGINAL_VM_GROUP" ] || [ -z "$SUBNET_ID" ]; then
        echo "Usage: $0 --operation restore-vm-group --original-vm-group <ORIGINAL_VM_GROUP> --resource-group <RESOURCE_GROUP> --subnet-id <SUBNET_ID> [--restore-primary-region] [--custom-metadata-file <CUSTOM_METADATA_FILE>]"
        exit 1
    fi

    if [ -n "$CUSTOM_METADATA_FILE" ]; then

        # Custom metadata file provided
        if [ ! -f "$CUSTOM_METADATA_FILE" ]; then
            log_error "Custom metadata file '$CUSTOM_METADATA_FILE' not found!"
            exit 1
        fi

        # No custom data
    fi

    log_info "--- Creating clones from original group of VMs '$ORIGINAL_VM_GROUP' using the last snapshots from metadata... ---"

    # Array to hold PIDs
    PIDS=()

    # Suppose VM_NAMES="vm1,vm2,vm3"
    IFS=',' read -ra VMS <<< "$ORIGINAL_VM_GROUP"
    for vm in "${VMS[@]}"; do
        echo "Processing $vm"

        # Get vm metadata
        if [ -n "$CUSTOM_METADATA_FILE" ]; then
            VM_INFO=$(jq -c --arg vm "$vm" '.[] | select(.vmName == $vm)' "$CUSTOM_METADATA_FILE")
        else
            VM_INFO=$(get_vm_metadata "$vm" "$RESOURCE_GROUP")
        fi

        if [ -z "$VM_INFO" ]; then
            log_warn "No metadata is available for VM '$vm'."
            continue
        fi
        
        # Get VM info from metadata
        VM_SIZE=$(echo "$VM_INFO" | jq -r '.vmSize')
        DISK_SKU=$(echo "$VM_INFO" | jq -r '.diskSku')

        # Get the most recent snapshot
        if [ "$RESTORE_TYPE" = "backup" ]; then
            # If RESTORE_TYPE is "backup", we want the last backup snapshot
            MOST_RECENT_SNAPSHOT=$(echo "$VM_INFO" | jq -c '.lastBackupSnapshot')
        else
            # If RESTORE_TYPE is "temporary", we want the last temporary snapshot
            MOST_RECENT_SNAPSHOT=$(echo "$VM_INFO" | jq -c '.lastTemporarySnapshot')
        fi

        if [ -z "$MOST_RECENT_SNAPSHOT" ]; then
            log_warn "No snapshots are available for VM '$vm'."
            continue
        fi

        SNAPSHOT_TO_USE=$(echo "$MOST_RECENT_SNAPSHOT" | jq -r -c '.name')

        # Create vm from snapshot
        UNIQUE_STR=$(tr -dc 'a-z0-9' </dev/urandom | head -c5)

        # Launch in background and collect PID
        log_info "=== Launching parallel process to create VM '$vm-$UNIQUE_STR' from snapshot '$SNAPSHOT_TO_USE'... ==="
        create_vm_from_snapshot $vm-$UNIQUE_STR $RESOURCE_GROUP $SNAPSHOT_TO_USE $VM_SIZE $DISK_SKU $SUBNET_ID &
        PIDS+=($!)
    done

    # Wait for all background jobs to finish
    for pid in "${PIDS[@]}"; do
        wait "$pid"
    done

    # Duration calculation
    restore_vm_group_end_date=$(date +%s)
    restore_vm_group_elapsed=$((restore_vm_group_end_date - restore_vm_group_start_date))
    restore_vm_group_minutes=$((restore_vm_group_elapsed / 60))
    restore_vm_group_seconds=$((restore_vm_group_elapsed % 60))

    log_info "--- Completed creating clones from original group of VMs '$ORIGINAL_VM_GROUP' using the last snapshots from metadata in ${restore_vm_group_minutes} minutes and ${restore_vm_group_seconds} seconds. ---"
}

# Function to create all VMs from most recent snapshots
restore_all_vms() {

    restore_all_vms_start_date=$(date +%s)

    ## Validate parameters
    if [ -z "$SUBNET_ID" ]; then
        echo "Usage: $0 --operation restore-all-vms --subnet-id <SUBNET_ID> [--restore-primary-region] [--custom-metadata-file <CUSTOM_METADATA_FILE>]"
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

        # Get the most recent snapshot
        if [ "$RESTORE_TYPE" = "backup" ]; then
            # If RESTORE_TYPE is "backup", we want the last backup snapshot
            MOST_RECENT_SNAPSHOT=$(echo "$vm_json" | jq -c '.lastBackupSnapshot')
        else
            # If RESTORE_TYPE is "temporary", we want the last temporary snapshot
            MOST_RECENT_SNAPSHOT=$(echo "$vm_json" | jq -c '.lastTemporarySnapshot')
        fi

        if [ -z "$MOST_RECENT_SNAPSHOT" ]; then
            log_warn "No snapshots are available for VM '$VM_NAME'."
            exit 1
        fi

        SNAPSHOT_TO_USE=$(echo "$MOST_RECENT_SNAPSHOT" | jq -r -c '.name')

        echo "$SNAPSHOT_TO_USE"

        # Create vm from snapshot
        UNIQUE_STR=$(tr -dc 'a-z0-9' </dev/urandom | head -c5)

        # Launch in background and collect PID
        log_info "=== Launching parallel process to create VM '$VM_NAME-$UNIQUE_STR' from snapshot '$SNAPSHOT_TO_USE'... ==="
        create_vm_from_snapshot $VM_NAME-$UNIQUE_STR $RESOURCE_GROUP $SNAPSHOT_TO_USE $VM_SIZE $DISK_SKU $SUBNET_ID &
        PIDS+=($!)
    done < <(jq -c '[.[] ][]' "$referenceMetadataFile")

    # Wait for all background jobs to finish
    for pid in "${PIDS[@]}"; do
        wait "$pid"
    done
    
    # Duration calculation
    restore_all_vms_end_date=$(date +%s)
    restore_all_vms_elapsed=$((restore_all_vms_end_date - restore_all_vms_start_date))
    restore_all_vms_minutes=$((restore_all_vms_elapsed / 60))
    restore_all_vms_seconds=$((restore_all_vms_elapsed % 60))

    log_info "--- Completed creating clones for all original VMs using the last snapshots from metadata in ${restore_all_vms_minutes} minutes and ${restore_all_vms_seconds} seconds. ---"
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
  echo "  --operation restore-vm --original-vm-name <ORIGINAL_VM_NAME> --resource-group <RESOURCE_GROUP> --subnet-id <SUBNET_ID> [--restore-primary-region] [--custom-metadata-file <CUSTOM_METADATA_FILE>]"
  echo "      Creates a VM from the most recent snapshot of the original VM in the metadata file. If a custom metadata file is not specified the default one is used."
  echo ""
  echo "  --operation restore-vm-group --original-vm-group <ORIGINAL_VM_GROUP> --resource-group <RESOURCE_GROUP> --subnet-id <SUBNET_ID> [--restore-primary-region] [--custom-metadata-file <CUSTOM_METADATA_FILE>]"
  echo "      Creates a group of VMs from the most recent snapshots of the original VMs in the metadata file. If a custom metadata file is not specified the default one is used."
  echo ""
  echo "  --operation restore-all-vms --subnet-id <SUBNET_ID> [--restore-primary-region] [--custom-metadata-file <CUSTOM_METADATA_FILE>]"
  echo "      Creates all VMs from the most recent snapshots of the original VMs in the metadata file. If a custom metadata file is not specified the default one is used."
  echo ""
  echo "  --help"
  echo "      Displays this help message."
}

# Parse command-line arguments
RESTORE_TYPE="backup"
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
        --restore-primary-region) RESTORE_TYPE="temporary" ;;
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
