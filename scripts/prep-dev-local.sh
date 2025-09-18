#!/bin/bash

# The user/sp running this script needs to have at least the role of "Key Vault Secrets Officer" in the Key Vault

# load environment variables
set -a && source .env && set +a

# Required variables
required_vars=(
    "resourceGroupName"
    "storageAccountName"
    "funcAppName"
    "localDevelopmentAppName"
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

# Get Subscription Id
SUBSCRIPTION_ID=$(az account show --query id -o tsv)

#
# Create Service principal to be used by GitHub Actions in deployments
#
#az ad sp create-for-rbac \
#    --name ${githubDeploymentAppName} \
#    --role contributor \
#    --scopes /subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${resourceGroupName}/providers/Microsoft.Web/sites/${funcAppName} \
#    --sdk-auth

# Variables
#appName="my-app-$(date +%s)"  # Unique app name using timestamp

# Create the application
appId=$(az ad app create \
  --display-name "$localDevelopmentAppName" \
  --query appId -o tsv)

echo "Application created with App ID: $appId"

# Create the service principal
spId=$(az ad sp create --id "$appId" --query id -o tsv)
echo "Service Principal created with Object ID: $spId"

# Generate a client secret (Azure will create it)
secret=$(az ad app credential reset \
  --id "$appId" \
  --append \
  --end-date "$(date -u -d '1 month' +%Y-%m-%dT%H:%M:%SZ)" \
  --query password -o tsv)

# Output credentials
echo "=============================="
echo "App Name: $localDevelopmentAppName"
echo "App ID: $appId"
echo "Service Principal ID: $spId"
echo "Client Secret: $secret"
echo "=============================="

# Assign Storage Blob and Queue roles to the new app on Storage Account
STORAGE_ACCOUNT_ID=$(az storage account show --name $storageAccountName --resource-group $resourceGroupName --query id -o tsv)
az role assignment create --assignee $spId --role "Storage Blob Data Owner" --scope $STORAGE_ACCOUNT_ID
az role assignment create --assignee $spId --role "Storage Queue Data Contributor" --scope $STORAGE_ACCOUNT_ID
az role assignment create --assignee $spId --role "Storage Table Data Contributor" --scope $STORAGE_ACCOUNT_ID

# Grant the "Monitoring Metrics Publisher" role on the DCR (or at the Resource Group/Subscription level if needed).
az role assignment create --assignee $spId --role "Monitoring Metrics Publisher" --scope /subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${resourceGroupName}

# Grant Contributor on the resource group
az role assignment create --assignee $spId --role "Contributor" --scope /subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${resourceGroupName}

# Get log ingestion values
LOG_INGESTION_RULE_ID=$(az monitor data-collection rule show --name $dcrName --resource-group $resourceGroupName --query "immutableId" --output tsv)
LOG_INGESTION_STREAM_NAME=$(az monitor data-collection rule show --name $dcrName --resource-group $resourceGroupName --query "streamDeclarations | keys(@)[0]" --output tsv)
LOGS_INGESTION_ENDPOINT=$(az monitor data-collection endpoint show --name $dceName --resource-group $resourceGroupName --query "logsIngestion.endpoint" --output tsv)

# Get tenant ID
TENANT_ID=$(az account show --query tenantId -o tsv)

#
# Generate example local.settings.json payload
#
cat > local.settings.dev.json <<EOF
{
  "IsEncrypted": false,
  "Values": {
    "FUNCTIONS_WORKER_RUNTIME": "node",
    "AzureWebJobsStorage__accountname": "$storageAccountName",
    "AZURE_TENANT_ID": "$TENANT_ID",
    "AZURE_CLIENT_ID": "$appId",
    "AZURE_CLIENT_SECRET": "$secret",
    "LOGS_INGESTION_ENDPOINT": "$LOG_INGESTION_ENDPOINT",
    "LOGS_INGESTION_RULE_ID": "$LOG_INGESTION_RULE_ID",
    "LOGS_INGESTION_STREAM_NAME": "$LOG_INGESTION_STREAM_NAME",
    "SNAPSHOT_SECONDARY_LOCATION": "westeurope",
    "SNAPSHOT_RETRY_CONTROL_COPY_MINUTES": 15,
    "SNAPSHOT_RETRY_CONTROL_PURGE_MINUTES": 15,
    "SNAPSHOT_PURGE_PRIMARY_LOCATION_NUMBER_OF_DAYS": 2,
    "SNAPSHOT_PURGE_SECONDARY_LOCATION_NUMBER_OF_DAYS": 30
  }
}
EOF