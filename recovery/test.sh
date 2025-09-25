#!/bin/bash

# query to get all the recovery metadata from the most recent snapshots
GRAPH_QUERY="resources
| where type == 'microsoft.compute/snapshots'
| where tags['smcp-recovery-info'] != ''
| extend smcpRecoveryInfo = tostring(tags['smcp-recovery-info']) 
| extend vmName = extract('vmName\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo)
| project snapshotName = name, vmName, timeCreated = todatetime(properties.timeCreated)
| summarize latestSnapshotTime = max(timeCreated) by vmName
| join kind=inner (
    resources
    | where type == 'microsoft.compute/snapshots'
| where tags['smcp-recovery-info'] != ''
| extend smcpRecoveryInfo = tostring(tags['smcp-recovery-info']) 
| extend vmName = extract('vmName\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo), vmSize = extract('vmSize\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo), diskSku = extract('diskSku\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo), diskProfile = extract('diskProfile\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo), ipAddress = extract('ipAddress\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo)
| project snapshotName = name, vmName, vmSize, diskSku, diskProfile, ipAddress, timeCreated = todatetime(properties.timeCreated), resourceGroup, id, location
) on vmName, \$left.latestSnapshotTime == \$right.timeCreated
| project snapshotName, resourceGroup, id, location, timeCreated, vmName, vmSize, diskSku, diskProfile, ipAddress"


# Get the most recent snapshots for each VM
last_snapshots=$(az graph query -q "$GRAPH_QUERY" \
  --query "data[].{SnapshotName:snapshotName,ResourceGroup:resourceGroup,Id:id,Location:location,TimeCreated:timeCreated,VMName:vmName,VMSize:vmSize,DiskSku:diskSku,DiskProfile:diskProfile,IPAddress:ipAddress}" -o tsv)

# Loop through each snapshot
while read -r snapshotName resourceGroup id location timeCreated vmName vmSize diskSku diskProfile ipAddress; do

    echo "Recovering VM $vmName ($vmSize, $ipAddress) with disk ($diskProfile, $diskSku) in resource group $resourceGroup from snapshot $snapshotName (id: $id), created at $timeCreated."
done <<< "$last_snapshots"

