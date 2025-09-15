   #!/bin/bash

   # List all snapshots and filter for failed ones
   failed_snapshots=$(az snapshot list --query "[?provisioningState=='Failed'].{Name:name, ResourceGroup:resourceGroup}" --output tsv)

   # Loop through each failed snapshot and delete it
   while read -r name resourceGroup; do
       echo "Deleting snapshot: $name in resource group: $resourceGroup"
       az snapshot delete --name "$name" --resource-group "$resourceGroup"
   done <<< "$failed_snapshots"
   