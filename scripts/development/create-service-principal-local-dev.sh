#!/bin/bash

# Service Principal Creation Script with Error Handling
# This script creates a service principal and deploys role assignments via Bicep

set -e  # Exit on any error

# Load environment variables
set -a && source .env && set +a

# Required variables
required_vars=(
    "prefix"
    "resourceGroupName" 
    "storageAccountName"
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

echo "🚀 Service Principal Setup for Local Development"
echo "================================================"

# Check if all required arguments have been set
check_required_arguments

# Get Subscription and Tenant information
SUBSCRIPTION_ID=$(az account show --query id -o tsv)
TENANT_ID=$(az account show --query tenantId -o tsv)
SP_NAME="${prefix}-local-dev-sp"

echo "📋 Configuration:"
echo "   Subscription: $SUBSCRIPTION_ID"
echo "   Tenant: $TENANT_ID"
echo "   Resource Group: $resourceGroupName"
echo "   Service Principal Name: $SP_NAME"
echo ""

####################################################################################

echo "🆕 Creating new service principal '$SP_NAME'..."

#
# Create Service principal to be used for local development
#
JSON_AUTH=$(az ad sp create-for-rbac \
    --name "$SP_NAME" \
    --role "Contributor" \
    --scopes /subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${resourceGroupName} \
    --json-auth)

# Extract clientId and clientSecret using jq
CLIENT_ID=$(echo "$JSON_AUTH" | jq -r '.clientId')
CLIENT_SECRET=$(echo "$JSON_AUTH" | jq -r '.clientSecret')

# Get the service principal object ID
SP_OBJECT_ID=$(az ad sp show --id "$CLIENT_ID" --query id -o tsv)

echo "✅ Application created with Client ID: $CLIENT_ID"
    
####################################################################################

echo ""
echo "🔧 Deploying Bicep template for role assignments..."

# Deploy the Bicep template
DEPLOYMENT_OUTPUT=$(az deployment group create \
    --resource-group "$resourceGroupName" \
    --template-file service-principal-setup.bicep \
    --parameters \
        prefix="$prefix" \
        servicePrincipalObjectId="$SP_OBJECT_ID" \
        servicePrincipalClientId="$CLIENT_ID" \
        servicePrincipalDisplayName="$SP_NAME" \
    --query "properties.outputs" \
    --output json)

echo "✅ Bicep deployment completed successfully!"

####################################################################################

echo ""
echo "📝 Generating local.settings.json..."

# Extract outputs from deployment
LOCAL_SETTINGS_JSON=$(echo "$DEPLOYMENT_OUTPUT" | jq -r '.localSettingsJson.value')

# Add the client secret to the configuration
LOCAL_SETTINGS_WITH_SECRET=$(echo "$LOCAL_SETTINGS_JSON" | jq --arg secret "$CLIENT_SECRET" '.Values.AZURE_CLIENT_SECRET = $secret')

# Save to file
echo "$LOCAL_SETTINGS_WITH_SECRET" | jq '.' > local.settings.dev.json

echo "✅ Configuration saved to: local.settings.dev.json"

####################################################################################

echo ""
echo "🎉 Service Principal Setup Complete!"
echo "===================================="
echo ""
echo "🔐 Service Principal Details:"
echo "   Name: $SP_NAME"
echo "   App ID: $CLIENT_ID"
echo "   Object ID: $SP_OBJECT_ID"
echo "   Secret: [HIDDEN - check local.settings.dev.json]"
echo ""
echo "🔑 Permissions Granted:"
PERMISSIONS=$(echo "$DEPLOYMENT_OUTPUT" | jq -r '.permissionsSummary.value[]')
echo "$PERMISSIONS" | sed 's/^/   • /'
echo ""
echo "📋 Next Steps:"
echo "   1. Copy local.settings.dev.json to ../local.settings.json"
echo "   2. Start your Azure Functions: cd .. && func start"
echo "   3. The service principal will authenticate automatically"
echo ""
echo "⚠️  Secret expires in 3 months - set a calendar reminder!"
echo "   To regenerate: az ad app credential reset --id $CLIENT_ID"
echo ""
echo "🔍 To verify setup:"
echo "   az storage blob list --account-name $storageAccountName --container-name test --auth-mode login"