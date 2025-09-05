#!/bin/bash

# load environment variables
set -a && source .env && set +a

# Required variables
required_vars=(
    "prefix"
    "resourceGroupName"
    "location"
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
# Create/Get a resource group.
#
rg_query=$(az group list --query "[?name=='$resourceGroupName']")
if [ "$rg_query" == "[]" ]; then
   echo -e "\nCreating Resource group '$resourceGroupName'"
   az group create --name ${resourceGroupName} --location ${location}
else
   echo "Resource group $resourceGroupName already exists."
fi

#
# Deploy log analytics workspace with a custom table + data collection rule + data infgestion endpoint using Bicep
#
DEPLOYMENT_OUTPUT=$(az deployment group create \
  --resource-group $resourceGroupName \
  --template-file azure-flex-env.bicep \
  --parameters prefix="$prefix" workbookJson=@snapshots-insights-workbook.json \
  --query "properties.outputs" \
  --output json)

echo -e "\nDeployment output:\n$DEPLOYMENT_OUTPUT\n"

