#!/bin/bash

# The user/sp running this script needs to have at least the role of "Key Vault Secrets Officer" in the Key Vault

# load environment variables
set -a && source .env && set +a

# Required variables
required_vars=(
    "resourceGroupName"
    "storageAccountName"
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

# Get current logged-in user information
CURRENT_USER_ID=$(az ad signed-in-user show --query id -o tsv)
CURRENT_USER_UPN=$(az ad signed-in-user show --query userPrincipalName -o tsv)
SUBSCRIPTION_ID=$(az account show --query id -o tsv)

echo "Assigning roles to logged-in user:"
echo "  User: $CURRENT_USER_UPN"
echo "  Object ID: $CURRENT_USER_ID"
echo "  Subscription: $SUBSCRIPTION_ID"

# Assign Monitor Publisher in the Resource Group to the logged-in user
echo "Assigning Resource Group roles..."
RESOURCE_GROUP_SCOPE="/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$resourceGroupName"
az role assignment create --assignee $CURRENT_USER_ID --role "Monitoring Metrics Publisher" --scope $RESOURCE_GROUP_SCOPE

# Assign Storage Blob and Queue roles to the logged-in user
STORAGE_ACCOUNT_ID=$(az storage account show --name $storageAccountName --resource-group $resourceGroupName --query id -o tsv)

echo "Assigning Storage roles..."
az role assignment create --assignee $CURRENT_USER_ID --role "Storage Blob Data Owner" --scope $STORAGE_ACCOUNT_ID
az role assignment create --assignee $CURRENT_USER_ID --role "Storage Queue Data Contributor" --scope $STORAGE_ACCOUNT_ID
az role assignment create --assignee $CURRENT_USER_ID --role "Storage Table Data Contributor" --scope $STORAGE_ACCOUNT_ID

echo "✅ Role assignments completed successfully!"
