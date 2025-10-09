#!/bin/bash

# load environment variables
set -a && source .env && set +a

# Variables
#SOURCE_RESOURCE_GROUP="xxxx"
#SOURCE_SNAPSHOT_NAME="xxxx"
#DEST_RESOURCE_GROUP="xxx"
#DEST_LOCATION="westeurope"  # Target region

# Step 1: Get the source snapshot ID
SOURCE_SNAPSHOT_ID=$(az snapshot show \
  --name $SOURCE_SNAPSHOT_NAME \
  --resource-group $SOURCE_RESOURCE_GROUP \
  --query id -o tsv)

# Step 2: Create a new snapshot in the destination region using the source snapshot as the source
az snapshot create \
  --name "${SOURCE_SNAPSHOT_NAME}-copy3" \
  --resource-group $DEST_RESOURCE_GROUP \
  --location $DEST_LOCATION \
  --source $SOURCE_SNAPSHOT_ID \
  --sku Standard_LRS \
  --tags copiedFrom=$SOURCE_SNAPSHOT_ID \
  --copy-start true \
  --incremental true

