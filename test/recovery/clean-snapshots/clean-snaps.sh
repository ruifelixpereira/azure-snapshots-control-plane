#!/bin/bash

# Define variables
LOCATION="westeurope"
RESOURCE_GROUP="INSTORE-UNIFO-LOJAS-PRD-RG-NE"

# List all snapshots in the specified resource group and location
snapshots=$(az snapshot list --resource-group "$RESOURCE_GROUP" --query "[?location=='$LOCATION']" --output json)

# Iterate over snapshots whose name ends with '-sec' and delete them
for name in $(echo $snapshots | jq -r '.[] | select(.name | endswith("-sec")) | .name'); do
    echo "Deleting snapshot: $name in resource group: $RESOURCE_GROUP"
    az snapshot delete --name "$name" --resource-group "$RESOURCE_GROUP" --no-wait
done
