#!/bin/bash

# Azure Storage Queue Message Sender for VM Recovery (Entra ID Auth)
# Usage: ./send-queue-message.sh [message-file.json]

#!/bin/bash

# load environment variables
set -a && source .env && set +a

# Required variables
required_vars=(
    "STORAGE_ACCOUNT_NAME"
)

# Set the current directory to where the script lives.
cd "$(dirname "$0")"

# Function to check if all required arguments have been set
check_required_arguments() {
    # Array to store the names of the missing arguments
    local missing_arguments=()

    # Loop through the array of required argument names
    for arg_name in "${required_vars[@]}"; do
        # Check if the argument value is empty
        if [[ -z "${!arg_name}" ]]; then
            # Add the name of the missing argument to the array
            missing_arguments+=("${arg_name}")
        fi
    done

    # Check if any required argument is missing
    if [[ ${#missing_arguments[@]} -gt 0 ]]; then
        echo -e "\nError: Missing required arguments:"
        printf '  %s\n' "${missing_arguments[@]}"
        [ ! \( \( $# == 1 \) -a \( "$1" == "-c" \) \) ] && echo "  Either provide a .env file or all the arguments, but not both at the same time."
        [ ! \( $# == 22 \) ] && echo "  All arguments must be provided."
        echo ""
        exit 1
    fi
}

####################################################################################

# Check if all required arguments have been set
check_required_arguments

####################################################################################


QUEUE_NAME="recovery-jobs"

# Function to send message to queue using Entra ID authentication
send_message() {
    local message_content="$1"
    local message_file="$2"
    
    echo "📨 Sending message to queue: $QUEUE_NAME"
    echo "🔐 Using Entra ID authentication"
    echo "📄 Message preview: ${message_content:0:200}..."
    
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

# Check if message file is provided
if [ $# -eq 1 ]; then
    MESSAGE_FILE="$1"
    if [ ! -f "$MESSAGE_FILE" ]; then
        echo "❌ File not found: $MESSAGE_FILE"
        exit 1
    fi
    
    echo "📖 Reading message from file: $MESSAGE_FILE"
    MESSAGE_CONTENT=$(cat "$MESSAGE_FILE")
    send_message "$MESSAGE_CONTENT" "$MESSAGE_FILE"
else
    # Create example message
    echo "📝 Creating example message..."
    
    MESSAGE_CONTENT='{
    "targetSubnetIds": [
        "/subscriptions/f42687d4-5f50-4f38-956b-7fcfa755ff58/resourceGroups/snap-second/providers/Microsoft.Network/virtualNetworks/vnet-sweden/subnets/default"
    ],
    "targetResourceGroup": "snap-second",
    "maxTimeGenerated": "2025-09-27T10:30:00.000Z",
    "useOriginalIpAddress": false,
    "waitForVmCreationCompletion": false,
    "vmFilter": [
        { "vm": "vm-001" },
        { "vm": "vm-002" }
    ]
}'

    echo $MESSAGE_CONTENT > example.json
fi

#echo ""
#echo "📋 Queue Information:"
#echo "   Queue Name: $QUEUE_NAME"
#echo "   Storage Account: $STORAGE_ACCOUNT_NAME"
#echo "   Authentication: Entra ID (Azure AD)"
#echo ""
#echo "🔧 Prerequisites:"
#echo "   1. Login to Azure CLI: az login"
#echo "   2. Ensure you have 'Storage Queue Data Contributor' role"
#echo "   3. Update STORAGE_ACCOUNT_NAME in this script"
#echo ""
#echo "🔧 To send custom messages:"
#echo "   1. Create a JSON file with BatchOrchestratorInput format"
#echo "   2. Run: $0 your-message.json"
#echo ""
#echo "🔐 Required Azure RBAC Roles:"
#echo "   - Storage Queue Data Contributor (on storage account or resource group)"
#echo "   - Reader (on storage account - usually inherited)"
#echo ""
#echo "📚 Example message format:"
echo "$MESSAGE_CONTENT"