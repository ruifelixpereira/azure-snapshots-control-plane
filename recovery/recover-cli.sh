#!/bin/bash

# This script provides a CLI interface to manage Azure VMs and snapshots.

# Exit immediately if any command fails (returns a non-zero exit code), preventing further execution.
set -e

# Metadata file name
DEFAULT_METADATA_FILE="recovery-metadata.json"

# T-shirt size to SKU mapping file
T_SHIRT_MAP_FILE="tshirt-map.json"

# Resource Graph query to get all the recovery metadata from the most recent snapshots
QUERY_MOST_RECENT="resources
| where type == 'microsoft.compute/snapshots'
| where tags['smcp-recovery-info'] != ''
| extend smcpRecoveryInfo = tostring(tags['smcp-recovery-info']) 
| extend vmName = extract('vmName\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo)
| project snapshotName = name, vmName, timeCreated = todatetime(properties.timeCreated)
| summarize latestSnapshotTime = max(timeCreated) by vmName
| join kind=inner (
    resources
    | where type == 'microsoft.compute/snapshots'
| where tags['smcp-recovery-info'] != ''
| extend smcpRecoveryInfo = tostring(tags['smcp-recovery-info']) 
| extend vmName = extract('vmName\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo), vmSize = extract('vmSize\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo), diskSku = extract('diskSku\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo), diskProfile = extract('diskProfile\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo), ipAddress = extract('ipAddress\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo)
| project snapshotName = name, vmName, vmSize, diskSku, diskProfile, ipAddress, timeCreated = todatetime(properties.timeCreated), resourceGroup, id, location
) on vmName, \$left.latestSnapshotTime == \$right.timeCreated
| project snapshotName, resourceGroup, id, location, timeCreated, vmName, vmSize, diskSku, diskProfile, ipAddress"

QUERY_MOST_RECENT_IN_REGION="resources
| where type == 'microsoft.compute/snapshots'
| where location == '__RESTORE_REGION__'
| where tags['smcp-recovery-info'] != ''
| extend smcpRecoveryInfo = tostring(tags['smcp-recovery-info']) 
| extend vmName = extract('vmName\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo)
| project snapshotName = name, vmName, timeCreated = todatetime(properties.timeCreated)
| summarize latestSnapshotTime = max(timeCreated) by vmName
| join kind=inner (
    resources
    | where type == 'microsoft.compute/snapshots'
| where tags['smcp-recovery-info'] != ''
| extend smcpRecoveryInfo = tostring(tags['smcp-recovery-info']) 
| extend vmName = extract('vmName\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo), vmSize = extract('vmSize\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo), diskSku = extract('diskSku\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo), diskProfile = extract('diskProfile\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo), ipAddress = extract('ipAddress\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo)
| project snapshotName = name, vmName, vmSize, diskSku, diskProfile, ipAddress, timeCreated = todatetime(properties.timeCreated), resourceGroup, id, location
) on vmName, \$left.latestSnapshotTime == \$right.timeCreated
| project snapshotName, resourceGroup, id, location, timeCreated, vmName, vmSize, diskSku, diskProfile, ipAddress"

# Resource Graph query to get the most recent for a specific VM in a specific resource group and location
QUERY_MOST_RECENT_FOR_VM_IN_REGION="resources
| where type == 'microsoft.compute/snapshots'
| where resourceGroup == '__RESOURCE_GROUP__' and location == '__RESTORE_REGION__'
| where tags['smcp-recovery-info'] != ''
| extend smcpRecoveryInfo = tostring(tags['smcp-recovery-info']) 
| extend vmName = extract('vmName\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo)
| where vmName == '__VM_NAME__'
| project snapshotName = name, vmName, timeCreated = todatetime(properties.timeCreated)
| summarize latestSnapshotTime = max(timeCreated) by vmName
| join kind=inner (
    resources
    | where type == 'microsoft.compute/snapshots'
| where tags['smcp-recovery-info'] != ''
| extend smcpRecoveryInfo = tostring(tags['smcp-recovery-info']) 
| extend vmName = extract('vmName\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo), vmSize = extract('vmSize\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo), diskSku = extract('diskSku\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo), diskProfile = extract('diskProfile\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo), ipAddress = extract('ipAddress\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo)
| project snapshotName = name, vmName, vmSize, diskSku, diskProfile, ipAddress, timeCreated = todatetime(properties.timeCreated), resourceGroup, id, location
) on vmName, \$left.latestSnapshotTime == \$right.timeCreated
| project snapshotName, resourceGroup, id, location, timeCreated, vmName, vmSize, diskSku, diskProfile, ipAddress"

# Resource Graph query to get the most recent for a group of VMs in a specific resource group and location
QUERY_MOST_RECENT_FOR_VM_GROUP_IN_REGION="resources
| where type == 'microsoft.compute/snapshots'
| where resourceGroup == '__RESOURCE_GROUP__' and location == '__RESTORE_REGION__'
| where tags['smcp-recovery-info'] != ''
| extend smcpRecoveryInfo = tostring(tags['smcp-recovery-info']) 
| extend vmName = extract('vmName\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo)
| where vmName in ('__VM_GROUP__')
| project snapshotName = name, vmName, timeCreated = todatetime(properties.timeCreated)
| summarize latestSnapshotTime = max(timeCreated) by vmName
| join kind=inner (
    resources
    | where type == 'microsoft.compute/snapshots'
| where tags['smcp-recovery-info'] != ''
| extend smcpRecoveryInfo = tostring(tags['smcp-recovery-info']) 
| extend vmName = extract('vmName\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo), vmSize = extract('vmSize\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo), diskSku = extract('diskSku\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo), diskProfile = extract('diskProfile\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo), ipAddress = extract('ipAddress\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo)
| project snapshotName = name, vmName, vmSize, diskSku, diskProfile, ipAddress, timeCreated = todatetime(properties.timeCreated), resourceGroup, id, location
) on vmName, \$left.latestSnapshotTime == \$right.timeCreated
| project snapshotName, resourceGroup, id, location, timeCreated, vmName, vmSize, diskSku, diskProfile, ipAddress"

# Resource Graph query template to get all snapshots for a specific VM in a specific resource group
QUERY_VM_SNAPSHOTS="resources
| where type == 'microsoft.compute/snapshots'
| where resourceGroup == '__RESOURCE_GROUP__'
| where tags['smcp-recovery-info'] != ''
| extend smcpRecoveryInfo = tostring(tags['smcp-recovery-info']) 
| extend vmName = extract('vmName\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo)
| where vmName == '__VM_NAME__'
| extend vmSize = extract('vmSize\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo), diskSku = extract('diskSku\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo), diskProfile = extract('diskProfile\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo), ipAddress = extract('ipAddress\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo)
| project snapshotName = name, resourceGroup, id, location, timeCreated = todatetime(properties.timeCreated), vmName, vmSize, diskSku, diskProfile, ipAddress"

# Logging functions
# These functions log messages with different severity levels (info, warn, error, debug).
log_info()    { echo "[INFO ] $(date '+%Y-%m-%d %H:%M:%S') $*"; }
log_warn()    { echo "[WARN ] $(date '+%Y-%m-%d %H:%M:%S') $*" >&2; }
log_error()   { echo "[ERROR] $(date '+%Y-%m-%d %H:%M:%S') $*" >&2; }
log_debug()   { [ "$DEBUG" = "1" ] && echo "[DEBUG] $(date '+%Y-%m-%d %H:%M:%S') $*"; }


# Function to export metadata for all VMs with most recent snapshots available in JSON format
export_most_recent_metadata() {

    export_metadata_start_date=$(date +%s)

    log_info "--- Exporting metadata for all VMs with active backup protection (including most recent snapshots available) in JSON format... ---"

    local outputMetadataFile=$CUSTOM_METADATA_FILE

    ## Validate parameters
    if [ -z "$outputMetadataFile" ]; then
        # Use the default name"
        outputMetadataFile="$DEFAULT_METADATA_FILE"
    fi

    # Get the most recent snapshots for each VM
    az graph query -q "$QUERY_MOST_RECENT" \
      --query "data[].{SnapshotName:snapshotName,ResourceGroup:resourceGroup,Id:id,Location:location,TimeCreated:timeCreated,VMName:vmName,VMSize:vmSize,DiskSku:diskSku,DiskProfile:diskProfile,IPAddress:ipAddress}" -o json  > $outputMetadataFile

    # Duration calculation
    export_metadata_end_date=$(date +%s)
    export_metadata_elapsed=$((export_metadata_end_date - export_metadata_start_date))
    export_metadata_minutes=$((export_metadata_elapsed / 60))
    export_metadata_seconds=$((export_metadata_elapsed % 60))

    log_info "--- Snapshots exported to $outputMetadataFile in ${export_metadata_minutes} minutes and ${export_metadata_seconds} seconds.---"
}

# Function to list the most recent snapshots for all VMs in JSON format
list_most_recent_snapshots() {

    log_info "--- Listing the most recent snapshots for all VMs in JSON format... ---"

    # Get the most recent snapshots for each VM
    az graph query -q "$QUERY_MOST_RECENT" \
      --query "data[].{SnapshotName:snapshotName,ResourceGroup:resourceGroup,Id:id,Location:location,TimeCreated:timeCreated,VMName:vmName,VMSize:vmSize,DiskSku:diskSku,DiskProfile:diskProfile,IPAddress:ipAddress}" -o json
}

# Function to list all snapshots for vm
list_vm_snapshots() {

    ## Validate parameters
    if [ -z "$RESOURCE_GROUP" ] || [ -z "$VM_NAME" ]; then
        echo "Usage: $0 --operation list-vm-snapshots --vm-name <VM_NAME> --resource-group <RESOURCE_GROUP>"
        exit 1
    fi

    log_info "--- Listing all snapshots for vm name '$VM_NAME' in the resource group '$RESOURCE_GROUP' in JSON format... ---"

    # Replace template variables
    escaped_rg=$(printf '%s' "$RESOURCE_GROUP" | sed 's/[\/&]/\\&/g')
    QUERY=$(echo "$QUERY_VM_SNAPSHOTS" | sed "s/__RESOURCE_GROUP__/$escaped_rg/g")

    escaped_vm=$(printf '%s' "$VM_NAME" | sed 's/[\/&]/\\&/g')
    QUERY=$(echo "$QUERY" | sed "s/__VM_NAME__/$escaped_vm/g")

    # Get the most recent snapshots for each VM
    az graph query -q "$QUERY" \
      --query "data[].{SnapshotName:snapshotName,ResourceGroup:resourceGroup,Id:id,Location:location,TimeCreated:timeCreated,VMName:vmName,VMSize:vmSize,DiskSku:diskSku,DiskProfile:diskProfile,IPAddress:ipAddress}" -o json
}


# Function to create a VM from a snapshot
create_vm_from_snapshot() {

    local newVmName=$1
    local originalResourceGroup=$2
    local snapshotName=$3
    local vmSize=$4
    local diskSku=$5
    local targetResourceGroup=$6
    local subnetId=$7

    ## Validate parameters
    if [ -z "$originalResourceGroup" ] || [ -z "$newVmName" ] || [ -z "$snapshotName" ] || [ -z "$vmSize" ] || [ -z "$diskSku" ] || [ -z "$subnetId" ] || [ -z "$targetResourceGroup" ]; then
        echo "Usage: create_vm_from_snapshot <NEW_VM_NAME> <ORIGINAL_RESOURCE_GROUP> <SNAPSHOT_NAME> <VM_SIZE> <DISK_SKU> <TARGET_RESOURCE_GROUP> <SUBNET_ID>"
        exit 1
    fi
    
    log_info "*** Creating VM '$newVmName' from snapshot '$snapshotName'... ***"

    # Get snapshot location to created disk + vm in the same region
    LOCATION=$(az snapshot show --name "$snapshotName" --resource-group "$originalResourceGroup" --query "location" -o tsv)
    snapshotId=$(az snapshot show --name "$snapshotName" --resource-group "$originalResourceGroup" --query "id" -o tsv)

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
    az disk create --resource-group "$targetResourceGroup" --name "${newVmName}_osdisk" --source "$snapshotId" --location "$LOCATION" --sku "$diskSku" --tag "smcp-creation=recovery"

    # Create the VM using the managed disk
    az vm create \
      --resource-group "$targetResourceGroup" \
      --name "$newVmName" \
      --attach-os-disk "${newVmName}_osdisk" \
      --os-type linux \
      --location "$LOCATION" \
      --subnet "$subnetId" \
      --public-ip-address "" \
      --nsg "" \
      --size "$vmSize" \
      --tag "smcp-creation=recovery"

    # Enable boot diagnostics
    az vm boot-diagnostics enable \
        --name "$newVmName" \
        --resource-group "$targetResourceGroup"

    log_info "*** Completed creating VM '$newVmName' from snapshot '$snapshotName'... ***"
}


#
# Restores a VM using the most recent snapshot and collecting the metadata from snaphsot tags.
#
restore_vm() {

    restore_vm_start_date=$(date +%s)

    ## Validate parameters
    if [ -z "$ORIGINAL_RESOURCE_GROUP" ] || [ -z "$ORIGINAL_VM_NAME" ] || [ -z "$TARGET_RESOURCE_GROUP" ] || [ -z "$SUBNET_ID" ]; then
        echo "Usage: $0 --operation restore-vm --original-vm-name <ORIGINAL_VM_NAME> --original-resource-group <ORIGINAL_RESOURCE_GROUP> --target-resource-group <TARGET_RESOURCE_GROUP> --subnet-id <SUBNET_ID>"
        exit 1
    fi

    ## Determine restore region from VNET location
    # Extract the VNet resource group and VNet name from the subnet ID
    VNET_RG=$(echo "$subnetId" | awk -F'/' '{for(i=1;i<=NF;i++){if($i=="resourceGroups"){print $(i+1)}}}')
    VNET_NAME=$(echo "$subnetId" | awk -F'/' '{for(i=1;i<=NF;i++){if($i=="virtualNetworks"){print $(i+1)}}}')

    # Get the VNet location
    VNET_LOCATION=$(az network vnet show --resource-group "$VNET_RG" --name "$VNET_NAME" --query "location" -o tsv)

    # Get vm metadata
    # Replace template variables
    escaped_rg=$(printf '%s' "$ORIGINAL_RESOURCE_GROUP" | sed 's/[\/&]/\\&/g')
    QUERY=$(echo "$QUERY_MOST_RECENT_FOR_VM_IN_REGION" | sed "s/__RESOURCE_GROUP__/$escaped_rg/g")

    escaped_region=$(printf '%s' "$VNET_LOCATION" | sed 's/[\/&]/\\&/g')
    QUERY=$(echo "$QUERY" | sed "s/__RESTORE_REGION__/$escaped_region/g")

    escaped_vm=$(printf '%s' "$ORIGINAL_VM_NAME" | sed 's/[\/&]/\\&/g')
    QUERY=$(echo "$QUERY" | sed "s/__VM_NAME__/$escaped_vm/g")

    # Get the most recent snapshots for each VM
    VM_INFO=$(az graph query -q "$QUERY" \
      --query "data[].{SnapshotName:snapshotName,ResourceGroup:resourceGroup,Id:id,Location:location,TimeCreated:timeCreated,VMName:vmName,VMSize:vmSize,DiskSku:diskSku,DiskProfile:diskProfile,IPAddress:ipAddress}" -o json)

    # Validate info
    if echo "$VM_INFO" | jq -e 'type == "array" and length == 1' > /dev/null; then
        echo $VM_INFO
        log_info "--- Creating clone from original VM '$ORIGINAL_VM_NAME' using the last snapshot... ---"
    else
        log_warn "No snapshots are available for VM '$ORIGINAL_VM_NAME' in region '$VNET_LOCATION'."
        exit 1
    fi

    # Get VM info from metadata
    VM_SIZE=$(echo "$VM_INFO" | jq -r '.[0].VMSize')
    DISK_SKU=$(echo "$VM_INFO" | jq -r '.[0].DiskSku')
    DISK_PROFILE=$(echo "$VM_INFO" | jq -r '.[0].DiskProfile')
    IP_ADDRESS=$(echo "$VM_INFO" | jq -r '.[0].IPAddress')
    SNAPSHOT_NAME=$(echo "$VM_INFO" | jq -r '.[0].SnapshotName')

    # Check disk profile is OS disk
    if [ "$DISK_PROFILE" != "os-disk" ]; then
        log_error "Snapshot '$SNAPSHOT_NAME' is not an OS disk (disk profile is '$DISK_PROFILE')."
        exit 1
    fi
    
    # Create vm from snapshot
    UNIQUE_STR=$(tr -dc 'a-z0-9' </dev/urandom | head -c5)
    create_vm_from_snapshot $ORIGINAL_VM_NAME-$UNIQUE_STR $ORIGINAL_RESOURCE_GROUP $SNAPSHOT_NAME $VM_SIZE $DISK_SKU $TARGET_RESOURCE_GROUP $SUBNET_ID

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
        echo "Usage: $0 --operation restore-vm-group --original-vm-group <ORIGINAL_VM_GROUP> --resource-group <RESOURCE_GROUP> --subnet-id <SUBNET_ID> [--custom-metadata-file <CUSTOM_METADATA_FILE>]"
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
  echo "  --operation list-vm-snapshots --vm-name <VM_NAME> --resource-group <RESOURCE_GROUP>"
  echo "      List available snapshots for a specific VM."
  echo ""
  echo "  --operation list-most-recent-snapshots"
  echo "      List the most recent snapshots for all VMs protected with active backups."
  echo ""
  echo "  --operation export-metadata [--custom-metadata-file <CUSTOM_METADATA_FILE>]"
  echo "      Exports metadata for all VMs protected with the most recent snapshots. If a custom metadata file name is not specified the default one is used."
  echo ""
  echo "  --operation create-vm --vm-name <VM_NAME> --resource-group <RESOURCE_GROUP> --snapshot-name <SNAPSHOT_NAME> --tshirt-size <TSHIRT_SIZE> --subnet-id <SUBNET_ID>"
  echo "      Creates a VM from a specified snapshot, using subnet location."
  echo ""
  echo "  --operation restore-vm --original-vm-name <ORIGINAL_VM_NAME> --original-resource-group <RESOURCE_GROUP> --target-resource-group <RESOURCE_GROUP> --subnet-id <SUBNET_ID>"
  echo "      Creates a VM from the most recent snapshot of the original VM in the target resource group and subnet, using subnet location."
  echo ""
  echo "  --operation restore-vm-group --original-vm-group <ORIGINAL_VM_GROUP> --original-resource-group <RESOURCE_GROUP> --target-resource-group <RESOURCE_GROUP> --subnet-id <SUBNET_ID>"
  echo "      Creates a group of VMs from the most recent snapshots of the original VMs in the target resource group and subnet, using subnet location."
  echo ""
  echo "  --operation restore-all-vms --target-resource-group <RESOURCE_GROUP> --subnet-id <SUBNET_ID>"
  echo "      Creates all VMs from the most recent snapshots of the original VMs in the target resource group and subnet, using subnet location."
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
        --original-resource-group) ORIGINAL_RESOURCE_GROUP="$2"; shift ;;
        --target-resource-group) TARGET_RESOURCE_GROUP="$2"; shift ;;
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
        list-vm-snapshots)
            list_vm_snapshots
            ;;
        list-most-recent-snapshots)
            list_most_recent_snapshots
            ;;
        export-metadata)
            export_most_recent_metadata
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

