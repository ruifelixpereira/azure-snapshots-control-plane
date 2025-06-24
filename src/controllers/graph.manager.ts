// Resource Graph
import { ILogger } from '../common/logger';
import { DefaultAzureCredential } from "@azure/identity";
import { ResourceGraphClient } from "@azure/arm-resourcegraph";
import { SnapshotSource } from "../common/interfaces";
import { ResourceGraphError, _getString } from "../common/apperror";

export class ResourceGraphManager {

    private clientGraph: ResourceGraphClient;

    constructor(private logger: ILogger) {
        const credential = new DefaultAzureCredential();
        this.clientGraph = new ResourceGraphClient(credential);
    }

    // Get all azure disks to backup using snapshots (tag backup=on)
    public async getDisksToBackup(): Promise<Array<SnapshotSource>> {

        try {
            const result = await this.clientGraph.resources(
                {
                    query: `resources
                    | where type =~ 'microsoft.compute/virtualMachines'
                    | where tags["backup"] =~ "on"
                    | project vmName=name, resourceGroup, vmId = id, vmSize = properties.hardwareProfile.vmSize, location, subscriptionId
                    | join (
                        resources
                        | where type =~ 'microsoft.compute/disks' and isnotempty(managedBy)
                        | project diskName = name, diskId = id, vmId=managedBy, diskSizeGB = properties.diskSizeGB, diskSku = sku.name
                    ) on vmId
                    | project subscriptionId, resourceGroup, location, vmId, vmName, vmSize, diskId, diskName, diskSizeGB, diskSku`
                },
                { resultFormat: "table" }
            );

            return result.data;
        } catch (error) {
            const message = `Unable to query resource graph with error: ${_getString(error)}`;
            this.logger.error(message);
            throw new ResourceGraphError(message);
        }
    };
}