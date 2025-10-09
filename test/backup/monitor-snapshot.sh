#!/bin/bash

# load environment variables
set -a && source .env && set +a

# Variables
#RESOURCE_GROUP_SNAP="your-resource-group"
#SNAPSHOT_NAME="your-snapshot-name"

# Loop to monitor provisioning state
while true; do
  az snapshot show \
    --resource-group $RESOURCE_GROUP_SNAP \
    --name $SNAPSHOT_NAME \
    --query "provisioningState" \
    -o tsv

  # Wait 10 seconds before checking again
  sleep 2
done