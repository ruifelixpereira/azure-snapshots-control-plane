#!/bin/bash

# Azure Storage Queue Message Sender for VM Recovery (Entra ID Auth)
# Usage: ./send-queue-message.sh [message-file.json]

#!/bin/bash

# load environment variables
set -a && source .env && set +a

# Required variables
required_vars=(
    "STORAGE_ACCOUNT_NAME"
    "SOURCE_QUEUE_NAME"
    "DESTINATION_QUEUE_NAME"
    "FUNCTION_URL"
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

MESSAGE_CONTENT="{
    \"sourceQueue\": {
      \"accountName\": \"${STORAGE_ACCOUNT_NAME}\",
      \"queueName\": \"${SOURCE_QUEUE_NAME}\"
    },
    \"destinationQueue\": {
      \"accountName\": \"${STORAGE_ACCOUNT_NAME}\", 
      \"queueName\": \"${DESTINATION_QUEUE_NAME}\"
    },
    \"maxMessages\": 32,
    \"deleteSource\": true
}"

echo "📨 Trigger copy messages from $SOURCE_QUEUE_NAME to $DESTINATION_QUEUE_NAME"
echo "🔐 Using Entra ID authentication"
echo "📄 Message preview: ${MESSAGE_CONTENT:0:200}..."

curl -X POST "$FUNCTION_URL" \
  -H "Content-Type: application/json" \
  -d "$MESSAGE_CONTENT"

echo ""
echo "✅ Message sent successfully!"
