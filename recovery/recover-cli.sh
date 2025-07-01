#!/bin/bash

# This script provides a CLI interface to manage Azure VMs and snapshots.

# Exit immediately if any command fails (returns a non-zero exit code), preventing further execution.
set -e

# Metadata file name
METADATA_FILE="recovery-metadata.json"

# Map T-shirt size to disk SKU and VM size
get_sku_for_tshirt_size() {
    local tshirt_size="$1"
    case "$tshirt_size" in
        S|s)
            DISK_SKU="Standard_LRS"
            VM_SIZE="Standard_B2als_v2"
            ;;
        M|m)
            DISK_SKU="StandardSSD_LRS"
            VM_SIZE="Standard_B2als_v2"
            ;;
        L|l)
            DISK_SKU="StandardSSD_LRS"
            VM_SIZE="Standard_B2as_v2"
            ;;
        XL|xl)
            DISK_SKU="Premium_LRS"
            VM_SIZE="Standard_D4as_v5"
            ;;
        *)
            echo "Unknown T-shirt size: $tshirt_size"
            exit 1
            ;;
    esac
}

# Function to list all VMs with the backup protection state
list_vms() {
    echo "Listing all VMs with the backup protection state..."
    echo -e "VmName\tResourceGroup\tBackup"
    az vm list --show-details --output json | jq -r '.[] | [.name, .resourceGroup, (.tags["smcp-backup"] // "off")] | @tsv'
}

# Function to list VMs with backup protection state 'on'
list_vms_with_backup_on() {
    echo "Listing VMs with active backup protection tag 'smcp-backup=on'..."
    echo -e "VmName\tResourceGroup\tLocation"
    az vm list --output json | jq -r '.[] | select(.tags["smcp-backup"] == "on") | [.name, .resourceGroup, .location] | @tsv'
}

# Function to list all snapshots for vm
list_snapshots_for_vm() {

    ## Validate parameters
    if [ -z "$RESOURCE_GROUP" ]; then
        #echo "Error: --resource-group parameter is required."
        echo "Usage: $0 --operation list-snapshots --vm-name <VM_NAME> --resource-group <RESOURCE_GROUP>"
        exit 1
    fi

    if [ -z "$VM_NAME" ]; then
        #echo "Error: --vm-name parameter is required."
        echo "Usage: $0 --operation list-snapshots --vm-name <VM_NAME> --resource-group <RESOURCE_GROUP>"
        exit 1
    fi

    echo "Listing all snapshots for vm name '$VM_NAME' in the resource group '$RESOURCE_GROUP'..."

    # Get the disk name associated with the VM
    DISK_NAME=$(az vm show --name "$VM_NAME" --resource-group "$RESOURCE_GROUP" --query "storageProfile.osDisk.name" -o tsv)
    
    # Print header row
    echo -e "SnapshotName\tResourceGroup\tLocation"

    # List snapshots
    az snapshot list --query "[?contains(name, '$DISK_NAME')].[name, resourceGroup, location]" -o tsv
}

# Function to export snapshots for all VMs in JSON format
export_all_snapshots_json() {
    echo "Exporting snapshots for all VMs in JSON format..."

    # Get VM metadata
    VMS=$(az vm list --query "[].{name:name, resourceGroup:resourceGroup, vmSize:hardwareProfile.vmSize}" -o json)
    echo "[" > $METADATA_FILE
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
            echo "," >> $METADATA_FILE
        fi
        echo "{\"vmName\": \"$VM_NAME\", \"resourceGroup\": \"$RESOURCE_GROUP\", \"vmSize\": \"$VM_SIZE\", \"diskSku\": \"$DISK_SKU\", \"diskSizeGB\": \"$DISK_SIZE\", \"snapshots\": $SNAPSHOTS}" >> $METADATA_FILE
    done
    echo "]" >> $METADATA_FILE
    echo "Snapshots exported to $METADATA_FILE"
}

export_most_recent_metadata_json() {
  echo "Exporting metadata with the most recent snapshots for all VMs to most_recent_metadata.json..."

  VMS=$(az vm list --query "[].{name:name, resourceGroup:resourceGroup}" -o json)
  echo "[" > most_recent_metadata.json
  FIRST=true

  echo "$VMS" | jq -c '.[]' | while read -r vm; do
    VM_NAME=$(echo "$vm" | jq -r '.name')
    RESOURCE_GROUP=$(echo "$vm" | jq -r '.resourceGroup')
    DISK_NAME=$(az vm show --name "$VM_NAME" --resource-group "$RESOURCE_GROUP" --query "storageProfile.osDisk.name" -o tsv)

    SNAPSHOTS=$(az snapshot list --query "[?contains(name, '$DISK_NAME')].[name, resourceGroup, location]" -o json)

    MOST_RECENT_SNAPSHOT=$(echo "$SNAPSHOTS" | jq -c '.[]' |       awk -F'"' '{print $2}' |       sort -r |       head -n 1)

    if [ -n "$MOST_RECENT_SNAPSHOT" ]; then
      SNAPSHOT_INFO=$(echo "$SNAPSHOTS" | jq -c --arg name "$MOST_RECENT_SNAPSHOT" '.[] | select(.[0] == $name)')
      NAME=$(echo "$SNAPSHOT_INFO" | jq -r '.[0]')
      RG=$(echo "$SNAPSHOT_INFO" | jq -r '.[1]')
      LOC=$(echo "$SNAPSHOT_INFO" | jq -r '.[2]')

      if [ "$FIRST" = true ]; then
        FIRST=false
      else
        echo "," >> most_recent_snapshots.json
      fi

      echo "  {\"vmName\": \"$VM_NAME\", \"snapshotName\": \"$NAME\", \"resourceGroup\": \"$RG\", \"location\": \"$LOC\"}" >> most_recent_snapshots.json
    fi
  done

  echo "]" >> most_recent_snapshots.json
  echo "Export completed to most_recent_snapshots.json"
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

    echo "Creating VM '$vmName' from snapshot '$snapshotName'..."

    # Get snapshot location to created disk + vm in the same region
    LOCATION=$(az snapshot show --name "$snapshotName" --resource-group "$resourceGroup" --query "location" -o tsv)

    ## Validate subnet location
    # Extract the VNet resource group and VNet name from the subnet ID
    VNET_RG=$(echo "$subnetId" | awk -F'/' '{for(i=1;i<=NF;i++){if($i=="resourceGroups"){print $(i+1)}}}')
    VNET_NAME=$(echo "$subnetId" | awk -F'/' '{for(i=1;i<=NF;i++){if($i=="virtualNetworks"){print $(i+1)}}}')

    # Get the VNet location
    VNET_LOCATION=$(az network vnet show --resource-group "$VNET_RG" --name "$VNET_NAME" --query "location" -o tsv)

    if [ "$VNET_LOCATION" != "$LOCATION" ]; then
        echo "Error: Subnet is in location '$VNET_LOCATION', but expected '$LOCATION'."
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
}


# Function to create a VM from a snapshot
create_vm_from_snapshot_ext() {

    ## Validate parameters
    if [ -z "$RESOURCE_GROUP" ] || [ -z "$VM_NAME" ] || [ -z "$SNAPSHOT_NAME" ] || [ -z "$TSHIRT_SIZE" ] || [ -z "$SUBNET_ID" ]; then
        echo "Usage: $0 --operation create-vm --vm-name <VM_NAME> --resource-group <RESOURCE_GROUP> --snapshot-name <SNAPSHOT_NAME> --tshirt-size <TSHIRT_SIZE> --subnet-id <SUBNET_ID>"
        exit 1
    fi

    echo "Creating VM '$VM_NAME' from snapshot '$SNAPSHOT_NAME'..."

    # Map T-shirt size to SKUs
    get_sku_for_tshirt_size "$TSHIRT_SIZE"

    # Create vm from snapshot
    create_vm_from_snapshot "$VM_NAME" "$RESOURCE_GROUP" "$SNAPSHOT_NAME" "$VM_SIZE" "$DISK_SKU" "$SUBNET_ID"
}

# Creates a VM using the information in the metadata file and using the most recent snaphsot in the metadata file
# This function assumes that the metadata file contains the necessary information to create the VM.
create_vm_from_metadata() {

    ## Validate parameters
    if [ -z "$VM_NAME" ] || [ -z "$SUBNET_ID" ]; then
        echo "Usage: $0 --operation create-vm-from-metadata --vm-name <VM_NAME> --subnet-id <SUBNET_ID>"
        exit 1
    fi

    # Check if metadata file exists
    if [ ! -f $METADATA_FILE ]; then
        echo "Metadata file '$METADATA_FILE' not found!"
        exit 1
    fi

    echo "Creating clone from VM '$VM_NAME' using the last snapshot from metadata..."

    # Get VM info from metadata
    VM_INFO=$(jq -c --arg vm "$VM_NAME" '.[] | select(.vmName == $vm)' $METADATA_FILE)
    RESOURCE_GROUP=$(echo "$VM_INFO" | jq -r -c '.resourceGroup')
    VM_SIZE=$(echo "$VM_INFO" | jq -r -c '.vmSize')
    DISK_SKU=$(echo "$VM_INFO" | jq -r -c '.diskSku')

    # Get all snapshots for VM
    SNAPSHOTS_INFO=$(echo "$VM_INFO" | jq -c '.snapshots')

    # Get the most recent snapshot
    MOST_RECENT_SNAPSHOT=$(echo "$SNAPSHOTS_INFO" | jq -r '.[].name' | sort -r | head -n 1)
    if [ -z "$MOST_RECENT_SNAPSHOT" ]; then
        echo "No snapshots are available for VM '$VM_NAME'."
        exit 1
    fi

    # Create vm from snapshot
    create_vm_from_snapshot $VM_NAME-recovered $RESOURCE_GROUP $MOST_RECENT_SNAPSHOT $VM_SIZE $DISK_SKU $SUBNET_ID
}



# Function to create VMs from most recent snapshots
create_vms_from_most_recent_snapshots() {
  echo "Creating VMs from most_recent_snapshots.json..."
  if [ ! -f most_recent_snapshots.json ]; then
    echo "most_recent_snapshots.json not found!"
    return 1
  fi

  jq -c '.[]' most_recent_snapshots.json | while read -r snapshot; do
    VM_NAME=$(echo "$snapshot" | jq -r '.vmName')
    SNAPSHOT_NAME=$(echo "$snapshot" | jq -r '.snapshotName')
    RESOURCE_GROUP=$(echo "$snapshot" | jq -r '.resourceGroup')
    LOCATION=$(echo "$snapshot" | jq -r '.location')

    echo "Creating managed disk for $VM_NAME from snapshot $SNAPSHOT_NAME..."
    az disk create --resource-group "$RESOURCE_GROUP" --name "${VM_NAME}_osdisk" --source "$SNAPSHOT_NAME"

    echo "Creating VM $VM_NAME..."
    az vm create \
      --resource-group "$RESOURCE_GROUP" \
      --name "$VM_NAME" \
      --attach-os-disk "${VM_NAME}_osdisk" \
      --os-type linux \
      --location "$LOCATION" \
      --subnet $targetVmSubnetId \
      --public-ip-address "" \
      --nsg "" \
      --size $SOURCE_VM_SIZE \
      --tag "smcp-creation=yes"

    # Enable boot diagnostics
    az vm boot-diagnostics enable \
        --name $VM_NAME \
        --resource-group $RESOURCE_GROUP
  done
}

print_help() {
  echo "Usage: $0 --operation <operation> [parameters]"
  echo ""
  echo "Available operations:"
  echo "  --operation list-vms"
  echo "      Lists all VMs and their backup protection state."
  echo ""
  echo "  --operation list-vms-with-backup"
  echo "      Lists VMs with the tag 'smcp-backup=on'."
  echo ""
  echo "  --operation list-snapshots --vm-name <VM_NAME> --resource-group <RESOURCE_GROUP>"
  echo "      Lists snapshots for a specific VM."
  echo ""
  echo "  --operation create-vm --snapshot-name <SNAPSHOT_NAME> --resource-group <RESOURCE_GROUP> --vm-name <VM_NAME> --tshirt-size <TSHIRT_SIZE>"
  echo "      Creates a VM from a specified snapshot."
  echo ""
  echo "  --operation create-vms-from-snapshots"
  echo "      Creates VMs from the snapshots listed in most_recent_snapshots.json."
  echo ""
  echo "  --help"
  echo "      Displays this help message."
}

# Parse command-line arguments
while [[ "$#" -gt 0 ]]; do
    case $1 in
        --operation) OPERATION="$2"; shift ;;
        --search-string) SEARCH_STRING="$2"; shift ;;
        --snapshot-name) SNAPSHOT_NAME="$2"; shift ;;
        --resource-group) RESOURCE_GROUP="$2"; shift ;;
        --subnet-id) SUBNET_ID="$2"; shift ;;
        --json-output) JSON_OUTPUT="$2"; shift ;;
        --vm-name) VM_NAME="$2"; shift ;;
        --tshirt-size) TSHIRT_SIZE="$2"; shift ;;
        --help) print_help; exit 0 ;;
        *) echo "Unknown parameter passed: $1"; exit 1 ;;
    esac
    shift
done

# Interactive mode if no operation is provided
if [ -z "$OPERATION" ]; then
    echo "Choose an operation:"
    echo "1) List all VMs and show the backup protection state"
    echo "2) List VMs with backup protection state 'on'"
    echo "3) List snapshots for virtual machine"
    echo "4) Export all virtual machines snapshots to JSON"
    echo "5) Export most recent snapshots to JSON"
    echo "6) Create a VM from a snapshot"
    echo "7) Create VMs from most recent snapshots"
    read -p "Enter choice [1-7]: " choice

    case $choice in
        1)
            list_vms
            ;;
        2)
            list_vms_with_backup_on
            ;;
        3)
            read -p "Enter resource group: " RESOURCE_GROUP
            read -p "Enter VM name: " VM_NAME
            list_snapshots_for_vm
            ;;
        4)
            export_all_snapshots_json
            ;;
        5)
            export_most_recent_snapshots_json
            ;;
        6)
            read -p "Enter snapshot name: " SNAPSHOT_NAME
            read -p "Enter resource group: " RESOURCE_GROUP
            read -p "Enter VM name: " VM_NAME
            read -p "Enter location: " LOCATION
            read -p "Enter TSHIRT size (one of these: S | M | L | XL): " TSHIRT_SIZE
            create_vm_from_snapshot_ext
            ;;
        7)
            create_vms_from_most_recent_snapshots
            ;;
        *)
            echo "Invalid choice"
            ;;
    esac
else
    # Non-interactive mode
    case $OPERATION in
        help)
            print_help
            ;;
        list-vms)
            list_vms
            ;;
        list-vms-with-backup)
            list_vms_with_backup_on
            ;;
        list-snapshots)
            list_snapshots_for_vm
            ;;
        export-snapshots)
            export_all_snapshots_json
            ;;
        export-most-recent-snapshots)
            export_most_recent_snapshots_json
            ;;
        create-vm)
            create_vm_from_snapshot_ext
            ;;
        create-vm-from-metadata)
            create_vm_from_metadata
            ;;
        create-vms-from-recent-snapshots)
            create_vms_from_most_recent_snapshots
            ;;
        *)
            echo "Invalid operation: $OPERATION"
            ;;
    esac
fi
