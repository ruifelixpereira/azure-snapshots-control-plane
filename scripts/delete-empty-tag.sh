#!/bin/bash

# Delete all snapshots with tag 'smcp-source-disk-id' = '' (empty).

# List all snapshots and filter for failed ones
empty_tag_snapshots=$(az graph query -q "resources
| where type =~ 'microsoft.compute/snapshots'
| where subscriptionId == 'xxxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'
| where name startswith 's202'
| where tostring(tags['smcp-source-disk-id']) == ''
| project id, name, resourceGroup, subscriptionId
" --query "data[].{Name:name,ResourceGroup:resourceGroup}" -o tsv)

# Loop through each empty tag snapshot and tag it
while read -r name resourceGroup; do
    echo "snapshot $name in resource group: $resourceGroup with empty tag smcp-source-disk-id found. Deleting it."
    az snapshot delete --name "$name" --resource-group "$resourceGroup"
done <<< "$empty_tag_snapshots"
