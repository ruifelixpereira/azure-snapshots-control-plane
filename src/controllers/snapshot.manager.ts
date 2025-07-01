// Disk snapshots
import { ILogger } from '../common/logger';
import { ComputeManagementClient } from "@azure/arm-compute";
import { DefaultAzureCredential } from "@azure/identity";
import { SnapshotError, _getString } from "../common/apperror";
import { SnapshotSource, Snapshot } from "../common/interfaces";
import { extractDiskNameFromDiskId, extractSnapshotNameFromSnapshotId, formatDateYYYYMMDDTHHMM } from "../common/utils";

 
export class SnapshotManager {

    private computeClient: ComputeManagementClient;

    constructor(private logger: ILogger, subscriptionId: string) {
        const credential = new DefaultAzureCredential();
        this.computeClient = new ComputeManagementClient(credential, subscriptionId);
    }

    public async createIncrementalSnapshot(source: SnapshotSource): Promise<Snapshot> {

        try {
            // Define the snapshot parameters
            const snapshotParams = {
                location: source.location,
                sku: {
                    name: "Standard_LRS"
                },
                creationData: {
                    createOption: "Copy",
                    sourceResourceId: source.diskId,
                },
                incremental: true, // Set to true for incremental snapshot
                tags: { 
                    "smcp-location-type": "primary"
                }
            };

            // New snapshot name
            const snapshotName = `s${formatDateYYYYMMDDTHHMM(new Date())}-${source.diskName}`;

            // Create the snapshot
            const result = await this.computeClient.snapshots.beginCreateOrUpdateAndWait(
                source.resourceGroup,
                snapshotName,
                snapshotParams
            );

            // Map the result to the Snapshot interface
            const snapshot: Snapshot = {
                id: result.id,
                name: result.name,
                location: result.location,
                resourceGroup: source.resourceGroup,
                subscriptionId: source.subscriptionId
            };

            // Return the created snapshot
            return snapshot;

        } catch (error) {
            const message = `Unable to create snapshot for disk '${source.diskName}' with error: ${_getString(error)}`;
            this.logger.error(message);
            throw new SnapshotError(message);
        }
    }


    public async startCopySnapshotToAnotherRegion(sourceSnapshot: Snapshot, targetLocation: string): Promise<Snapshot> {

        try {
            const credential = new DefaultAzureCredential();
            const computeClient = new ComputeManagementClient(credential, sourceSnapshot.subscriptionId);

            // Get the source snapshot
            const source = await computeClient.snapshots.get(sourceSnapshot.resourceGroup, sourceSnapshot.name);

            // Create the snapshot in the target region
            const targetSnapshotParams = {
                location: targetLocation,
                sku: {
                    name: "Standard_LRS"
                },
                creationData: {
                    createOption: "CopyStart",
                    sourceResourceId: source.id, // Use the source snapshot ID
                },
                incremental: true, // Set to true for incremental snapshot
                tags: { 
                    "smcp-location-type": "secondary"
                }
            };

            const result = await computeClient.snapshots.beginCreateOrUpdate(
                sourceSnapshot.resourceGroup,
                `${sourceSnapshot.name}-sec`,
                targetSnapshotParams
            );

            return {
                id: `${sourceSnapshot.id}-sec`,
                name: `${sourceSnapshot.name}-sec`,
                location: targetLocation,
                resourceGroup: sourceSnapshot.resourceGroup,
                subscriptionId: sourceSnapshot.subscriptionId
            };

        } catch (error) {
            const message = `Unable to start copying snapshot '${sourceSnapshot.name}' to another region '${targetLocation}' with error: ${_getString(error)}`;
            this.logger.error(message);
            throw new SnapshotError(message);
        }
    }

    public async getSnapshotCopyState(resourceGroup: string, snapshotName: string): Promise<string> {

        try {
            const snapshot = await this.computeClient.snapshots.get(resourceGroup, snapshotName);
            return snapshot.provisioningState === "Succeeded" ? "Succeeded" : (snapshot.provisioningState === "Failed" ? "Failed" : "InProgress");
        } catch (error) {
            const message = `Unable to check snapshot copy status for '${snapshotName}' with error: ${_getString(error)}`;
            this.logger.error(message);
            throw new SnapshotError(message);
        }
    }

    public async startPurgePrimarySnapshotsOfDiskIdAndLocationOlderThan(
        resourceGroupName: string,
        diskId: string,
        location: string,
        baseDate: Date,
        days: number
    ): Promise<string[]> {
        const deletedSnapshots: string[] = [];
        try {
            const cutoff = new Date(baseDate.getTime() - days * 24 * 60 * 60 * 1000);

            for await (const snapshot of this.computeClient.snapshots.listByResourceGroup(resourceGroupName)) {
                if (
                    snapshot.timeCreated &&
                    new Date(snapshot.timeCreated) < cutoff &&
                    snapshot.creationData &&
                    snapshot.creationData.sourceResourceId &&
                    snapshot.creationData?.sourceResourceId?.toLowerCase() === diskId.toLowerCase() &&
                    snapshot.location &&
                    snapshot.location?.toLowerCase() === location.toLowerCase()
                ) {
                    this.logger.info(
                        `Deleting primary snapshot '${snapshot.name}' for diskId '${diskId}' in location '${location}' created at ${snapshot.timeCreated}`
                    );
                    await this.computeClient.snapshots.beginDelete(resourceGroupName, snapshot.name);
                    deletedSnapshots.push(snapshot.name);
                }
            }
            return deletedSnapshots;
        } catch (error) {
            const message = `Unable to purge primary snapshots of diskId '${diskId}' in location '${location}' older than ${days} days with error: ${_getString(error)}`;
            this.logger.error(message);
            throw new SnapshotError(message);
        }
    }

    public async startPurgeSecondarySnapshotsOfDiskIdAndLocationOlderThan(
        resourceGroupName: string,
        diskId: string,
        location: string,
        baseDate: Date,
        days: number
    ): Promise<string[]> {
        const deletedSnapshots: string[] = [];
        try {
            const cutoff = new Date(baseDate.getTime() - days * 24 * 60 * 60 * 1000);

            for await (const snapshot of this.computeClient.snapshots.listByResourceGroup(resourceGroupName)) {

                // get disk name from disk id
                const diskName = extractDiskNameFromDiskId(diskId);

                // get source resource name from snapshot id
                const sourceSnapshotName = extractSnapshotNameFromSnapshotId(snapshot.creationData?.sourceResourceId);

                if (
                    snapshot.timeCreated &&
                    new Date(snapshot.timeCreated) < cutoff &&
                    snapshot.creationData &&
                    snapshot.creationData.sourceResourceId &&
                    sourceSnapshotName &&
                    sourceSnapshotName.toLowerCase().includes(`-${diskName.toLowerCase()}`) &&
                    snapshot.location?.toLowerCase() === location.toLowerCase()
                ) {
                    this.logger.info(
                        `Deleting secondary snapshot '${snapshot.name}' for disk '${diskName}' in location '${location}' created at ${snapshot.timeCreated}`
                    );
                    await this.computeClient.snapshots.beginDelete(resourceGroupName, snapshot.name);
                    deletedSnapshots.push(snapshot.name);
                }
            }
            return deletedSnapshots;
        } catch (error) {
            const message = `Unable to purge secondary snapshots for disk id '${diskId}' in location '${location}' older than ${days} days with error: ${_getString(error)}`;
            this.logger.error(message);
            throw new SnapshotError(message);
        }
    }

    public async isSnapshotDeleted(resourceGroupName: string, snapshotName: string): Promise<boolean> {
        try {
            await this.computeClient.snapshots.get(resourceGroupName, snapshotName);
            // If no error, snapshot still exists
            return false;
        } catch (error: any) {
            if (error.statusCode === 404 || error.code === "ResourceNotFound") {
                // Snapshot not found, so it is deleted
                return true;
            }
            // Other errors should be handled/logged
            const message = `Unable to check if snapshot '${snapshotName}' is deleted with error: ${_getString(error)}`;
            this.logger.error(message);
            throw new SnapshotError(message);
        }
    }

    public async areSnapshotsDeleted(resourceGroupName: string, snapshotNames: string[]): Promise<{ [name: string]: boolean }> {
        const results: { [name: string]: boolean } = {};
        for (const snapshotName of snapshotNames) {
            try {
                await this.computeClient.snapshots.get(resourceGroupName, snapshotName);
                // If no error, snapshot still exists
                results[snapshotName] = false;
            } catch (error: any) {
                if (error.statusCode === 404 || error.code === "ResourceNotFound") {
                    // Snapshot not found, so it is deleted
                    results[snapshotName] = true;
                } else {
                    const message = `Unable to check if snapshot '${snapshotName}' is deleted with error: ${_getString(error)}`;
                    this.logger.error(message);
                    throw new SnapshotError(message);
                }
            }
        }
        return results;
    }

}
