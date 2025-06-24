#!/bin/bash

# load environment variables
set -a && source .env && set +a

# Required variables
required_vars=(
    "resourceGroupName"
    "location"
    "logAnalyticsWorkspaceName"
    "customLogAnalyticsTableName"
    "dcrName"
    "dceName"
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

#
# Deploy bicep
#

DEPLOYMENT_OUTPUT=$(az deployment group create \
  --resource-group $resourceGroupName \
  --template-file log-ingestion.bicep \
  --parameters workspaceName="$logAnalyticsWorkspaceName" tableName="$customLogAnalyticsTableName" dcrName="$dcrName" dceName="$dceName" \
  --query "properties.outputs" \
  --output json)

echo -e "\nDeployment output:\n$DEPLOYMENT_OUTPUT\n"

LOG_INGESTION_ENDPOINT=$(echo $DEPLOYMENT_OUTPUT | jq -r .logIngestionEndpoint.value)
LOG_INGESTION_RULE_ID=$(echo $DEPLOYMENT_OUTPUT | jq -r .logIngestionRuleId.value)
LOG_INGESTION_STREAM_NAME=$(echo $DEPLOYMENT_OUTPUT | jq -r .logIngestionStreamName.value)

echo "Log Ingestion Endpoint: $LOG_INGESTION_ENDPOINT"
echo "Log Ingestion Rule ID: $LOG_INGESTION_RULE_ID"
echo "Log Ingestion Stream Name: $LOG_INGESTION_STREAM_NAME"
