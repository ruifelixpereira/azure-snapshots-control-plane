#!/bin/bash

# This script provides a CLI interface to manage Azure VMs and snapshots.

# Exit immediately if any command fails (returns a non-zero exit code), preventing further execution.
set -e

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
| extend vmName = extract('vmName\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo), vmSize = extract('vmSize\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo), diskSku = extract('diskSku\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo), diskProfile = extract('diskProfile\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo), ipAddress = extract('ipAddress\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo), securityType = extract('securityType\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo)
| project snapshotName = name, vmName, vmSize, diskSku, diskProfile, ipAddress, securityType, timeCreated = todatetime(properties.timeCreated), resourceGroup, id, location
) on vmName, \$left.latestSnapshotTime == \$right.timeCreated
| project snapshotName, resourceGroup, id, location, timeCreated, vmName, vmSize, diskSku, diskProfile, ipAddress, securityType"

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
| extend vmName = extract('vmName\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo), vmSize = extract('vmSize\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo), diskSku = extract('diskSku\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo), diskProfile = extract('diskProfile\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo), ipAddress = extract('ipAddress\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo), securityType = extract('securityType\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo)
| project snapshotName = name, vmName, vmSize, diskSku, diskProfile, ipAddress, securityType, timeCreated = todatetime(properties.timeCreated), resourceGroup, id, location
) on vmName, \$left.latestSnapshotTime == \$right.timeCreated
| project snapshotName, resourceGroup, id, location, timeCreated, vmName, vmSize, diskSku, diskProfile, ipAddress, securityType"

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
| extend vmName = extract('vmName\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo), vmSize = extract('vmSize\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo), diskSku = extract('diskSku\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo), diskProfile = extract('diskProfile\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo), ipAddress = extract('ipAddress\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo), securityType = extract('securityType\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo)
| project snapshotName = name, vmName, vmSize, diskSku, diskProfile, ipAddress, securityType, timeCreated = todatetime(properties.timeCreated), resourceGroup, id, location
) on vmName, \$left.latestSnapshotTime == \$right.timeCreated
| project snapshotName, resourceGroup, id, location, timeCreated, vmName, vmSize, diskSku, diskProfile, ipAddress, securityType"

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
| extend vmName = extract('vmName\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo), vmSize = extract('vmSize\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo), diskSku = extract('diskSku\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo), diskProfile = extract('diskProfile\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo), ipAddress = extract('ipAddress\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo), securityType = extract('securityType\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo)
| project snapshotName = name, vmName, vmSize, diskSku, diskProfile, ipAddress, securityType, timeCreated = todatetime(properties.timeCreated), resourceGroup, id, location
) on vmName, \$left.latestSnapshotTime == \$right.timeCreated
| project snapshotName, resourceGroup, id, location, timeCreated, vmName, vmSize, diskSku, diskProfile, ipAddress, securityType"

# Resource Graph query template to get all snapshots for a specific VM in a specific resource group
QUERY_VM_SNAPSHOTS="resources
| where type == 'microsoft.compute/snapshots'
| where resourceGroup == '__RESOURCE_GROUP__'
| where tags['smcp-recovery-info'] != ''
| extend smcpRecoveryInfo = tostring(tags['smcp-recovery-info']) 
| extend vmName = extract('vmName\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo)
| where vmName == '__VM_NAME__'
| extend vmSize = extract('vmSize\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo), diskSku = extract('diskSku\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo), diskProfile = extract('diskProfile\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo), ipAddress = extract('ipAddress\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo), securityType = extract('securityType\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo)
| project snapshotName = name, resourceGroup, id, location, timeCreated = todatetime(properties.timeCreated), vmName, vmSize, diskSku, diskProfile, ipAddress, securityType"

# Queue name in the storage account used to trigger VM restoration
QUEUE_NAME="recovery-jobs"

# Logging functions
# These functions log messages with different severity levels (info, warn, error, debug).
log_info()    { echo "[INFO ] $(date '+%Y-%m-%d %H:%M:%S') $*"; }
log_warn()    { echo "⚠️ $(date '+%Y-%m-%d %H:%M:%S') $*" >&2; }
log_error()   { echo "❌ $(date '+%Y-%m-%d %H:%M:%S') $*" >&2; }
log_debug()   { [ "$DEBUG" = "1" ] && echo "[DEBUG] $(date '+%Y-%m-%d %H:%M:%S') $*"; }

# Function to list the most recent snapshots for all VMs in JSON format
list_most_recent_snapshots() {
    # Get the most recent snapshots for each VM
    az graph query -q "$QUERY_MOST_RECENT" \
      --query "data[].{SnapshotName:snapshotName,ResourceGroup:resourceGroup,Id:id,Location:location,TimeCreated:timeCreated,VMName:vmName,VMSize:vmSize,DiskSku:diskSku,DiskProfile:diskProfile,IPAddress:ipAddress,SecurityType:securityType}" -o json
}

# Function to list all snapshots for vm
list_vm_snapshots() {

    ## Validate parameters
    if [ -z "$RESOURCE_GROUP" ] || [ -z "$VM_NAME" ]; then
        echo "💡 Usage: $0 --operation list-vm-snapshots --vm-name <VM_NAME> --resource-group <RESOURCE_GROUP>"
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
      --query "data[].{SnapshotName:snapshotName,ResourceGroup:resourceGroup,Id:id,Location:location,TimeCreated:timeCreated,VMName:vmName,VMSize:vmSize,DiskSku:diskSku,DiskProfile:diskProfile,IPAddress:ipAddress,SecurityType:securityType}" -o json
}


# Function to send message to queue using Entra ID authentication
send_message() {
    local message_content="$1"
    
    echo "📨 Sending message to queue: $QUEUE_NAME"
    echo "🔐 Using Entra ID authentication"
    #echo "📄 Message preview: ${message_content:0:200}..."
    
    # Check if user is logged in to Azure CLI
    if ! az account show >/dev/null 2>&1; then
        echo "❌ Not logged in to Azure CLI. Please run 'az login' first."
        exit 1
    fi
    
    # Get current user info
    CURRENT_USER=$(az account show --query "user.name" -o tsv 2>/dev/null)
    echo "👤 Authenticated as: $CURRENT_USER"
    
    # Send message using Azure CLI with Entra ID authentication and Base64 encoding
    echo "📤 Sending message to storage account: $STORAGE_ACCOUNT_NAME"
    
    # Encode message content as Base64
    ENCODED_CONTENT=$(echo -n "$message_content" | base64)
    echo "🔐 Message encoded as Base64"
    
    az storage message put \
        --queue-name "$QUEUE_NAME" \
        --content "$ENCODED_CONTENT" \
        --account-name "$STORAGE_ACCOUNT_NAME" \
        --auth-mode login
    
    if [ $? -eq 0 ]; then
        echo "✅ Message sent successfully!"
        echo "🔍 Monitor the function logs to see the orchestration start"
    else
        echo "❌ Failed to send message"
        echo "💡 Ensure you have 'Storage Queue Data Contributor' role on the storage account"
        exit 1
    fi
}

# Create a sample data file for VM restoration
create_sample_data_file() {

    MESSAGE_CONTENT='{
    "targetSubnetIds": [
        "/subscriptions/xxx-xxx-xxx-xxx/resourceGroups/recovery-rg/providers/Microsoft.Network/virtualNetworks/recovery-vnet/subnets/default"
    ],
    "targetResourceGroup": "recovery-rg",
    "maxTimeGenerated": "2025-09-27T10:30:00.000Z",
    "useOriginalIpAddress": false,
    "waitForVmCreationCompletion": false,
    "appendUniqueStringToVmName": false,
    "vmFilter": ["vm-001","vm-002"]
    }'

    echo $MESSAGE_CONTENT
}

# Function to create VMs (one or more, or even all) from most recent snapshots
restore_vms() {

    ## Validate parameters
    if [ -z "$STORAGE_ACCOUNT_NAME" ] || [ -z "$DATA_FILE" ]; then
        echo "💡 Usage: $0 --operation restore-vms --storage-account <STORAGE_ACCOUNT_NAME> --data <DATA_FILE>"
        exit 1
    fi

    # Check if message file is provided
    if [ ! -f "$DATA_FILE" ]; then
        echo "❌ File not found: $DATA_FILE"
        exit 1
    fi
        
    echo "📖 Reading restoration data from: $DATA_FILE"
    MESSAGE_CONTENT=$(cat "$DATA_FILE")
    send_message "$MESSAGE_CONTENT"

    echo "✅ Started VM restoration. Please track the restoration progress using the Recovery Insights Workbook in the Azure Portal."
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
  echo "  --operation create-sample-data-file"
  echo "      Creates a sample data file for VM restoration."
  echo ""
  echo "  --operation restore-vms --data <DATA_FILE>"
  echo "      Restores the one, a group or all VMs from the most recent snapshots in the target resource group and subnet, using subnet location."
  echo ""
  echo "  --help"
  echo "      Displays this help message."
}

# Parse command-line arguments
RESTORE_TYPE="backup"
while [[ "$#" -gt 0 ]]; do
    case $1 in
        --operation) OPERATION="$2"; shift ;;
        --resource-group) RESOURCE_GROUP="$2"; shift ;;
        --vm-name) VM_NAME="$2"; shift ;;
        --data) DATA_FILE="$2"; shift ;;
        --storage-account) STORAGE_ACCOUNT_NAME="$2"; shift ;;
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
        create-sample-data-file)
            create_sample_data_file
            ;;
        restore-vms)
            restore_vms
            ;;
        *)
            echo "❌ Invalid operation: $OPERATION"
            ;;
    esac
fi

