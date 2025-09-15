#!/bin/bash

# load environment variables
set -a && source .env && set +a

# Required variables
required_vars=(
    "resourceGroupName"
    "location"
    "storageAccountName"
    "funcAppName"
    "redisCacheName"
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
# Create/Get a resource group.
#
rg_query=$(az group list --query "[?name=='$resourceGroupName']")
if [ "$rg_query" == "[]" ]; then
   echo -e "\nCreating Resource group '$resourceGroupName'"
   az group create --name ${resourceGroupName} --location ${location}
else
   echo "Resource group $resourceGroupName already exists."
   #RG_ID=$(az group show --name $resource_group --query id -o tsv)
fi

#
# Create storage account
#
sa_query=$(az storage account list --query "[?name=='$storageAccountName']")
if [ "$sa_query" == "[]" ]; then
    echo -e "\nCreating Storage account '$storageAccountName'"
    az storage account create \
        --name $storageAccountName \
        --resource-group ${resourceGroupName} \
        --allow-blob-public-access true \
        --allow-shared-key-access true \
        --kind StorageV2 \
        --sku Standard_LRS
else
    echo "Storage account $storageAccountName already exists."
fi

#
# Create Function App
#
fa_query=$(az functionapp list --resource-group $resourceGroupName --query "[?name=='$funcAppName']")
if [ "$fa_query" == "[]" ]; then
    echo -e "\nCreating Function app '$funcAppName'"
    az functionapp create \
        --consumption-plan-location $location \
        --name $funcAppName \
        --os-type Linux \
        --resource-group $resourceGroupName \
        --runtime node \
        --functions-version 4 \
        --runtime-version 20 \
        --storage-account $storageAccountName \
        --assign-identity
else
    echo "Function app '$funcAppName' already exists."
fi

#
# Add permissions to the Function App assigned identity
#
FUNCAPP_ID=$(az functionapp identity show --name $funcAppName --resource-group $resourceGroupName --query principalId -o tsv)

# Assign Storage Blob and Queue roles to Function App assigned identity on Storage Account
STORAGE_ACCOUNT_ID=$(az storage account show --name $storageAccountName --resource-group $resourceGroupName --query id -o tsv)
az role assignment create --assignee $FUNCAPP_ID --role "Storage Blob Data Owner" --scope $STORAGE_ACCOUNT_ID
az role assignment create --assignee $FUNCAPP_ID --role "Storage Queue Data Contributor" --scope $STORAGE_ACCOUNT_ID
az role assignment create --assignee $FUNCAPP_ID --role "Storage Table Data Owner" --scope $STORAGE_ACCOUNT_ID

#
# Create Storage Queues
#
az storage queue create --name "snapshot-jobs" --account-name $storageAccountName
az storage queue create --name "copy-jobs" --account-name $storageAccountName
az storage queue create --name "copy-control" --account-name $storageAccountName
az storage queue create --name "purge-jobs" --account-name $storageAccountName
az storage queue create --name "bulk-purge-jobs" --account-name $storageAccountName
az storage queue create --name "purge-control" --account-name $storageAccountName
az storage queue create --name "dead-letter-snapshot-creation-jobs" --account-name $storageAccountName

#
# Deploy log analytics workspace with a custom table + data collection rule + data infgestion endpoint using Bicep
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

#
# Add default application settings to Function App
#
az functionapp config appsettings set --name $funcAppName --resource-group $resourceGroupName --settings \
    LOGS_INGESTION_ENDPOINT="$LOG_INGESTION_ENDPOINT" \
    LOGS_INGESTION_RULE_ID="$LOG_INGESTION_RULE_ID" \
    LOGS_INGESTION_STREAM_NAME="$LOG_INGESTION_STREAM_NAME" \
    SNAPSHOT_SECONDARY_LOCATION="westeurope" \
    SNAPSHOT_RETRY_CONTROL_COPY_MINUTES="10" \
    SNAPSHOT_RETRY_CONTROL_PURGE_MINUTES="10" \
    SNAPSHOT_PURGE_PRIMARY_LOCATION_NUMBER_OF_DAYS="1" \
    SNAPSHOT_PURGE_SECONDARY_LOCATION_NUMBER_OF_DAYS="11"

#
# Grant additional permissions to the Function App assigned identity
#

# Get the resource group ID
RG_ID=$(az group show --name "$resourceGroupName" --query id -o tsv)

# Grant the Managed Identity the "Monitoring Metrics Publisher" role on the DCR (or at the Resource Group/Subscription level if needed).
az role assignment create --assignee $FUNCAPP_ID --role "Monitoring Metrics Publisher" --scope ${RG_ID}

# Grant Contributor on the resource group
az role assignment create --assignee $FUNCAPP_ID --role "Contributor" --scope ${RG_ID}


#
# Deploy Snapshots Insights Workbook
#

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


# get function app managed identity principal id (you already set FUNCAPP_ID earlier)
FUNC_PRINCIPAL_ID=$(az functionapp identity show --name "$funcAppName" --resource-group "$resourceGroupName" --query principalId -o tsv)

#
# Redis Cache
#
az redis create \
  --location $location \
  --name $redisCacheName \
  --resource-group $resourceGroupName \
  --sku Basic \
  --vm-size c0 \
  --mi-system-assigned \
  --disable-access-keys true \
  --redis-configuration @config_redis_enable-aad.json

# get redis resource id
REDIS_ID=$(az redis show --name "$redisCacheName" --resource-group "$resourceGroupName" --query id -o tsv)

# assign data-plane role so the function can authenticate to Redis via AAD
az role assignment create --assignee "$FUNC_PRINCIPAL_ID" --role "Azure Cache for Redis Data Contributor" --scope "$REDIS_ID"
