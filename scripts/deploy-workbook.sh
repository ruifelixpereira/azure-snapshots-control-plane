#!/bin/bash

# load environment variables
set -a && source .env && set +a

# Required variables
required_vars=(
    "resourceGroupName"
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

# Get the resource group ID
RG_ID=$(az group show --name "$resourceGroupName" --query id -o tsv)

# Generate a unique GUID for the workbook
WORKBOOK_GUID=$(cat /proc/sys/kernel/random/uuid)

# Create the Azure Monitor Application Insights workbook using the provided serialized data
az monitor app-insights workbook create \
    -n "$WORKBOOK_GUID" \
    -g "$resourceGroupName" \
    --source-id "$RG_ID" \
    --serialized-data "@snapshots-insights-workbook.json" \
    --kind shared \
    --category workbook \
    --display-name "Azure Snapshots Insights"
