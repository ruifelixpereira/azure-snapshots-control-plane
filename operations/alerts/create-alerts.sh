#!/bin/bash

# Service Principal Creation Script with Error Handling
# This script creates a service principal and deploys role assignments via Bicep

set -e  # Exit on any error

# Load environment variables
set -a && source .env && set +a

# Required variables
required_vars=(
    "resourceGroupName"
    "actionGroups_post_webhook_url"
    "logAnalyticsWorkspace_resource_id"
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

echo "🚀 Alerts Setup"
echo "=============================="

# Check if all required arguments have been set
check_required_arguments

# Get Subscription and Tenant information
SUBSCRIPTION_ID=$(az account show --query id -o tsv)
TENANT_ID=$(az account show --query tenantId -o tsv)

####################################################################################

echo ""
echo "🔧 Deploying Bicep template for alert rule and action group..."

# Deploy the Bicep template
DEPLOYMENT_OUTPUT=$(az deployment group create \
    --resource-group "$resourceGroupName" \
    --template-file alert-setup.bicep \
    --parameters \
        actionGroups_post_webhook_url="$actionGroups_post_webhook_url" \
        logAnalyticsWorkspace_resource_id="$logAnalyticsWorkspace_resource_id" \
      --query "properties.outputs" \
    --output json)

echo "✅ Bicep deployment completed successfully!"

####################################################################################
