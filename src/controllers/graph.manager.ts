// Resource Graph
import { ILogger } from '../common/logger';
import { DefaultAzureCredential } from "@azure/identity";
import { ResourceGraphClient } from "@azure/arm-resourcegraph";
import { SnapshotSource, SnapshotToPurge, RecoverySnapshot } from "../common/interfaces";
import { ResourceGraphError, _getString } from "../common/apperror";

export class ResourceGraphManager {

    private clientGraph: ResourceGraphClient;

    constructor(private logger: ILogger) {
        const credential = new DefaultAzureCredential();
        this.clientGraph = new ResourceGraphClient(credential);
    }

    // Get all azure disks to backup using snapshots (tag smcp-backup=on)
    public async getDisksToBackup(triggerTagKey: string, triggerTagValue: string): Promise<Array<SnapshotSource>> {

        try {
            const result = await this.clientGraph.resources(
                {
                    query: `resources
                    | where type =~ 'microsoft.compute/virtualMachines'
                    | where tags["${triggerTagKey}"] =~ "${triggerTagValue}"
                    | mv-expand nic=properties.networkProfile.networkInterfaces
                    | project vmName=name, resourceGroup, vmId = tolower(id), vmSize = properties.hardwareProfile.vmSize, location, subscriptionId, osDiskId = properties.storageProfile.osDisk.managedDisk.id, nicId = tolower(tostring(nic.id)), securityType = coalesce(properties.securityProfile.securityType, "Standard")
                    | join (
                        resources
                        | where type =~ 'microsoft.compute/disks' and isnotempty(managedBy)
                        | project diskName = name, diskId = id, vmId = tolower(managedBy), diskSizeGB = properties.diskSizeGB, diskSku = sku.name
                        ) on vmId
                    | join kind=leftouter (
                        resources
                        | where type =~ 'microsoft.network/networkinterfaces'
                        | mv-expand ipconfig=properties.ipConfigurations
                        | project nicId = tolower(id), ipAddress = tostring(ipconfig.properties.privateIPAddress)
                        ) on nicId
                    | extend diskProfile = iff(tolower(diskId) == tolower(osDiskId), 'os-disk', 'data-disk')
                    | project subscriptionId, resourceGroup, location, vmId, vmName, vmSize, diskId, diskName, diskSizeGB, diskSku, diskProfile, ipAddress, securityType`
                },
                { resultFormat: "table" }
            );

            return result.data;
        } catch (error) {
            const message = `Unable to query resource graph with error: ${_getString(error)}`;
            this.logger.error(message);
            throw new ResourceGraphError(message);
        }
    }


    /**
     * Query all snapshots in a resource group and location, where sourceResourceId matches and timeCreated <= cutoffDate.
     * @param resourceGroup The resource group to filter.
     * @param location The Azure location to filter.
     * @param sourceResourceId The source resource ID to match.
     * @param cutoffDate The cutoff date (ISO string, e.g. "2025-09-05T00:00:00Z").
     * @returns Array of snapshot objects.
     */
    public async getSnapshotsBySourceAndDate(
        resourceGroups: string[],
        sourceResourceId: string,
        primaryCutoffDate: string,
        secondaryCutoffDate: string
    ): Promise<Array<SnapshotToPurge>> {
        try {

            const resourceGroupsFilter = resourceGroups.map(rg => `'${rg.toLowerCase()}'`).join(", ");
            const result = await this.clientGraph.resources(
                {
                    query: `resources
                    | where type =~ 'microsoft.compute/snapshots'
                    | where tolower(resourceGroup) in (${resourceGroupsFilter})
                    | where (tolower(name) !endswith "-sec" and todatetime(properties.timeCreated) <= todatetime('${primaryCutoffDate}')) or (tolower(name) endswith "-sec" and todatetime(properties.timeCreated) <= todatetime('${secondaryCutoffDate}'))
                    | extend primarySourceResourceId = tolower(properties.creationData.sourceResourceId)
                    | extend secondarySourceResourceId = tolower(tags['smcp-source-disk-id'])
                    | where primarySourceResourceId =~ tolower('${sourceResourceId}') or secondarySourceResourceId =~ tolower('${sourceResourceId}')
                    | extend sourceResourceName = split(properties.creationData.sourceResourceId, '/')[8]
                    | project id, name, location, resourceGroup, subscriptionId, sourceResourceId = secondarySourceResourceId, sourceResourceName, timeCreated = properties.timeCreated`
                },
                { resultFormat: "table" }
            );
            return result.data;
        } catch (error) {
            const message = `Unable to query snapshots by source and date with error: ${_getString(error)}`;
            this.logger.error(message);
            throw new ResourceGraphError(message);
        }
    }


    // Get the most recent snapshots in a certain region for all VMs
    public async getMostRecentSnapshotsInRegions(regions: string[], maxTimeGenerated: Date, vmFilter?: string[]): Promise<Array<RecoverySnapshot>> {

        try {

            const filterForVms = vmFilter && vmFilter.length > 0 
                ? `| where vmName in (${vmFilter.map(vm => `'${vm}'`).join(", ")})`
                : "";

            const query = `resources
                    | where type == 'microsoft.compute/snapshots'
                    | where location in (${regions.map(region => `'${region}'`).join(", ")})
                    | extend timeCreated = todatetime(properties.timeCreated)
                    | where timeCreated <= todatetime('${maxTimeGenerated.toISOString()}')
                    | where tags['smcp-recovery-info'] != ''
                    | extend smcpRecoveryInfo = tostring(tags['smcp-recovery-info'])
                    | extend vmName = extract('vmName\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo) ${filterForVms}
                    | project snapshotName = name, vmName, timeCreated
                    | summarize latestSnapshotTime = max(timeCreated) by vmName
                    | join kind=inner (
                        resources
                        | where type == 'microsoft.compute/snapshots'
                        | where tags['smcp-recovery-info'] != ''
                        | extend smcpRecoveryInfo = tostring(tags['smcp-recovery-info']) 
                        | extend vmName = extract('vmName\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo), vmSize = extract('vmSize\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo), diskSku = extract('diskSku\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo), diskProfile = extract('diskProfile\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo), ipAddress = extract('ipAddress\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo), securityType = coalesce(extract('securityType\\\":\\\"([^\\\"]+)', 1, smcpRecoveryInfo), 'Standard')
                        | project snapshotName = name, vmName, vmSize, diskSku, diskProfile, ipAddress, timeCreated = todatetime(properties.timeCreated), resourceGroup, id, location, securityType
                        ) on vmName, $left.latestSnapshotTime == $right.timeCreated
                    | project snapshotName, resourceGroup, id, location, timeCreated, vmName, vmSize, diskSku, diskProfile, ipAddress, securityType`;

            const result = await this.clientGraph.resources(
                {
                    query: query
                },
                { resultFormat: "table" }
            );

            return result.data;
        } catch (error) {
            const message = `Unable to query resource graph with error: ${_getString(error)}`;
            this.logger.error(message);
            throw new ResourceGraphError(message);
        }
    }

}
