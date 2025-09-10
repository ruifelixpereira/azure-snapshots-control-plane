#!/bin/bash

# load environment variables
set -a && source .env && set +a

# Variables
#RESOURCE_GROUP="xxxxxx"
#STORAGE_ACCOUNT="xxxxxx"

# Get the storage account key
ACCOUNT_KEY=$(az storage account keys list \
  --resource-group $RESOURCE_GROUP \
  --account-name $STORAGE_ACCOUNT \
  --query "[0].value" -o tsv)

# List all containers
CONTAINERS=$(az storage container list \
  --account-name $STORAGE_ACCOUNT \
  --account-key $ACCOUNT_KEY \
  --query "[].name" -o tsv)

# Create a temp file to store blob info
TMP_FILE=$(mktemp)

# Loop through containers and collect blob sizes
for CONTAINER in $CONTAINERS; do
  az storage blob list \
    --account-name $STORAGE_ACCOUNT \
    --account-key $ACCOUNT_KEY \
    --container-name $CONTAINER \
    --query "[].{name:name, size:properties.contentLength, container:'$CONTAINER'}" \
    -o json >> $TMP_FILE
done

# Show top 10 largest blobs (size in bytes)
cat $TMP_FILE | jq -s 'add | sort_by(.size) | reverse | .[:10]'