#!/bin/bash

# Service Principal Creation Script with Error Handling
# This script creates a service principal and deploys role assignments via Bicep

set -e  # Exit on any error

# Load environment variables
set -a && source .env && set +a

# Required variables
required_vars=(
    "prefix"
    "snapshotsTargetResourceGroupName"
    "snapshotsTargetSubscriptionId"
    "funcAppName"
    "funcAppResourceGroup"
    "localDevSpName"
)

# Set the current directory to where the script lives
cd "$(dirname "$0")"

# Function to check if all required arguments have been set
check_required_arguments() {
    local missing_arguments=()
    for arg_name in "${required_vars[@]}"; do
        if [[ -z "${!arg_name}" ]]; then
            missing_arguments+=("${arg_name}")
        fi
    done
    
    if [[ ${#missing_arguments[@]} -gt 0 ]]; then
        echo -e "\nError: Missing required arguments:"
        printf '  %s\n' "${missing_arguments[@]}"
        echo "  Please provide a .env file with all required variables."
        echo ""
        exit 1
    fi
}

####################################################################################

echo "🆕 Creating custom role for lock admin..."

# Read template and replace variables
ROLE_DEFINITION=$(cat ./lock-admin-template.json | \
    sed "s|<subId>|${snapshotsTargetSubscriptionId}|g" | \
    sed "s|<rg-name>|${snapshotsTargetResourceGroupName}|g")

# Check if role already exists
ROLE_NAME="Resource Lock Administrator Snapshots"
EXISTING_ROLE=$(az role definition list --query "[?roleName=='$ROLE_NAME']" -o tsv)
if [[ -n "$EXISTING_ROLE" ]]; then
    echo "⚠️ Role $ROLE_NAME already exists."
else
    # Create role definition using the modified JSON
    echo "$ROLE_DEFINITION" | az role definition create --role-definition @-
fi

# Assign role to the local development service principal
if [[ -z "$localDevSpName" ]]; then
    echo "❗ localDevSpName is not set. Please set it in the .env file."
else
    echo "🔐 Assigning role to local development service principal..."
    SP_ID=$(az ad sp list --display-name "${localDevSpName}" --query "[0].appId" -o tsv)
    az role assignment create --assignee "$SP_ID" --role "${ROLE_NAME}" --scope "/subscriptions/${snapshotsTargetSubscriptionId}/resourceGroups/${snapshotsTargetResourceGroupName}"
fi

# Assign role to the function app's managed identity
echo "🔐 Assigning role to function app's managed identity..."
FUNC_IDENTITY_PRINCIPAL_ID=$(az functionapp identity show --name "${funcAppName}" --resource-group "${funcAppResourceGroup}" --query "principalId" -o tsv)
az role assignment create --assignee "$FUNC_IDENTITY_PRINCIPAL_ID" --role "${ROLE_NAME}" --scope "/subscriptions/${snapshotsTargetSubscriptionId}/resourceGroups/${snapshotsTargetResourceGroupName}"
echo "✅ Role assignment completed."