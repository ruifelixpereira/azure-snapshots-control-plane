#!/bin/bash

# Tag all snapshots without tag 'smcp-source-disk-id' with the source disk ID
# Example:
#    snapshot name: s20250811T2231-diskname(-sec)
#    snapshot ID: /subscriptions/xxxx/resourceGroups/myResourceGroup/providers/Microsoft.Compute/snapshots/s20250811T2231-diskname(-sec)
#    source disk ID: /subscriptions/xxxx/resourceGroups/myResourceGroup/providers/Microsoft.Compute/disks/diskname",

#    az snapshot update --name mySnapshot --resource-group myResourceGroup --set tags.sourceDiskId="/subscriptions/xxxx/resourceGroups/myResourceGroup/providers/Microsoft.Compute/dis
#    Result: snapshot mySnapshot will have a tag sourceDiskId with the value of the source disk ID


# List all snapshots and filter for failed ones
untagged_snapshots=$(az snapshot list \
  --query "[?starts_with(name, 's202') && (tags==null || !contains(keys(tags), 'smcp-source-disk-id'))].{Name:name,ResourceGroup:resourceGroup}" \
  -o tsv)

# Loop through each untagged snapshot and tag it
while read -r name resourceGroup; do

    # New tag value
    # Extract the disk name from the snapshot name by removing the timestamp prefix and optional '-sec' suffix
    diskName=$(echo "$name" | sed -E 's/^s[0-9]{8}T[0-9]{4}-//; s/-sec$//')
    sourceDiskId=$(az disk show --name "$diskName" --resource-group "$resourceGroup" --query "id" -o tsv 2>/dev/null)

    echo "tagging snapshot: $name in resource group: $resourceGroup" and diskname $diskName with tag smcp-source-disk-id="$sourceDiskId"
    az snapshot update --name "$name" --resource-group "$resourceGroup" --set tags.smcp-source-disk-id="$sourceDiskId"
done <<< "$untagged_snapshots"
