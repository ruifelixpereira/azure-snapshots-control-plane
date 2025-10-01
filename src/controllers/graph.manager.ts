// Resource Graph
import { ILogger } from '../common/logger';
import { DefaultAzureCredential } from "@azure/identity";
import { ResourceGraphClient } from "@azure/arm-resourcegraph";
import { SnapshotSource, SnapshotToPurge } from "../common/interfaces";
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
     * Query all snapshots in a given resource group and location, where the name includes a given substring.
     * @param resourceGroup The resource group to filter.
     * @param location The Azure location to filter.
     * @param diskName The diskname substring to match in the snapshot name.
     * @param cutoffDate The cutoff date (ISO string, e.g. "2025-09-05T00:00:00Z").
     * @returns Array of snapshot objects.
     */
    public async getSnapshotsByNameAndDate(resourceGroup: string, location: string, diskName: string, cutoffDate: string): Promise<Array<SnapshotToPurge>> {
        try {
            const result = await this.clientGraph.resources(
                {
                    query: `resources
                    | where type =~ 'microsoft.compute/snapshots'
                    | where tolower(resourceGroup) =~ tolower('${resourceGroup}')
                    | where tolower(location) =~ tolower('${location}')
                    | extend sourceResourceName = split(properties.creationData.sourceResourceId, '/')[8]
                    | where tolower(sourceResourceName) contains tolower('-${diskName}')
                    | where todatetime(properties.timeCreated) <= todatetime('${cutoffDate}')
                    | project id, name, location, resourceGroup, subscriptionId, sourceResourceId = properties.creationData.sourceResourceId, sourceResourceName,timeCreated = properties.timeCreated`
                },
                { resultFormat: "table" }
            );
            return result.data;
        } catch (error) {
            const message = `Unable to query snapshots with error: ${_getString(error)}`;
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
        resourceGroup: string,
        location: string,
        sourceResourceId: string,
        cutoffDate: string
    ): Promise<Array<SnapshotToPurge>> {
        try {
            const result = await this.clientGraph.resources(
                {
                    query: `resources
                    | where type =~ 'microsoft.compute/snapshots'
                    | where tolower(resourceGroup) =~ tolower('${resourceGroup}')
                    | where tolower(location) =~ tolower('${location}')
                    | where tolower(properties.creationData.sourceResourceId) =~ tolower('${sourceResourceId}')
                    | where todatetime(properties.timeCreated) <= todatetime('${cutoffDate}')
                    | extend sourceResourceName = split(properties.creationData.sourceResourceId, '/')[8]
                    | project id, name, location, resourceGroup, subscriptionId, sourceResourceId = properties.creationData.sourceResourceId, sourceResourceName, timeCreated = properties.timeCreated`
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

}
