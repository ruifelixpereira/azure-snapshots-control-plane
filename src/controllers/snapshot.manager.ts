// Disk snapshots
import { ILogger } from '../common/logger';
import { ComputeManagementClient } from "@azure/arm-compute";
import { ResourceGraphManager } from "./graph.manager";
import { DefaultAzureCredential } from "@azure/identity";
import { SnapshotError, _getString } from "../common/apperror";
import { SnapshotSource, Snapshot, SnapshotToPurge } from "../common/interfaces";
import { extractDiskNameFromDiskId, extractSnapshotNameFromSnapshotId, formatDateYYYYMMDDTHHMM } from "../common/utils";

 
export class SnapshotManager {

    private computeClient: ComputeManagementClient;
    private graphManager: ResourceGraphManager;

    constructor(private logger: ILogger, subscriptionId: string) {
        const credential = new DefaultAzureCredential();
        this.computeClient = new ComputeManagementClient(credential, subscriptionId);
        this.graphManager = new ResourceGraphManager(logger);
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


    /**
     * Purge primary snapshots only if all destination (copied) snapshots created from this source snapshot are in provisioningState "Succeeded".
     */
    public async startPurgePrimarySnapshotsOfDiskIdAndLocationOlderThan(
        resourceGroupName: string,
        diskId: string,
        location: string,
        baseDate: Date,
        days: number,
        requiredTag?: string
    ): Promise<string[]> {
        const deletedSnapshots: string[] = [];
        try {
            const cutoff = new Date(baseDate.getTime() - days * 24 * 60 * 60 * 1000);

            // List all snapshots once and reuse the collection in the two subsequent loops
            const allSnapshots: Array<any> = [];
            for await (const s of this.computeClient.snapshots.listByResourceGroup(resourceGroupName)) {
                allSnapshots.push(s);
            }

            // Iterate over all snapshots to find source (primary) snapshots to consider for deletion
            for (const snapshot of allSnapshots) {
                if (
                    snapshot.timeCreated &&
                    new Date(snapshot.timeCreated) < cutoff &&
                    snapshot.creationData &&
                    snapshot.creationData.sourceResourceId &&
                    snapshot.creationData?.sourceResourceId?.toLowerCase() === diskId.toLowerCase() &&
                    snapshot.location &&
                    snapshot.location?.toLowerCase() === location.toLowerCase()
                ) {

                    // Validate tag existence if requiredTag is provided
                    if (requiredTag && (!snapshot.tags || !(requiredTag in snapshot.tags))) {
                        this.logger.info(
                            `Skipping snapshot '${snapshot.name}' because required tag '${requiredTag}' does not exist.`
                        );
                        continue;
                    }

                    // Find all destination snapshots created from this source snapshot
                    const sourceSnapshotId = snapshot.id;
                    let allDestSucceeded = true;

                    if (!sourceSnapshotId) {
                        this.logger.warn(`Source snapshot '${snapshot.name}' has no id; skipping deletion.`);
                        continue;
                    }

                    // List all snapshots in the resource group and check if any have creationData.sourceResourceId == sourceSnapshotId
                    for (const destSnapshot of allSnapshots) {
                        if (
                            destSnapshot.creationData &&
                            destSnapshot.creationData.sourceResourceId &&
                            destSnapshot.creationData.sourceResourceId.toLowerCase() === sourceSnapshotId.toLowerCase()
                        ) {
                            // If any destination snapshot is not succeeded, skip deletion of the source
                            if (destSnapshot.provisioningState !== "Succeeded") {
                                allDestSucceeded = false;
                                this.logger.warn(
                                    `Cannot delete source snapshot '${snapshot.name}' because destination snapshot '${destSnapshot.name}' is in provisioningState '${destSnapshot.provisioningState}'`
                                );
                                break;
                            }
                        }
                    }

                    if (allDestSucceeded) {
                        this.logger.info(
                            `Deleting primary snapshot '${snapshot.name}' for diskId '${diskId}' in location '${location}' created at ${snapshot.timeCreated}`
                        );
                        await this.computeClient.snapshots.beginDelete(resourceGroupName, snapshot.name);
                        deletedSnapshots.push(snapshot.name);
                    } else {
                        this.logger.info(
                            `Skipping deletion of source snapshot '${snapshot.name}' because not all destination snapshots are in 'Succeeded' state`
                        );
                    }
                }
            }
            return deletedSnapshots;
        } catch (error) {
            const message = `Unable to purge primary snapshots of diskId '${diskId}' in location '${location}' and resource group '${resourceGroupName}' older than ${days} days since '${baseDate.toISOString()}' with error: ${_getString(error)}`;
            this.logger.error(message);
            throw new SnapshotError(message);
        }
    }

    /*
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
            const message = `Unable to purge primary snapshots of diskId '${diskId}' in location '${location}' and resource group '${resourceGroupName}' older than ${days} days since '${baseDate.toISOString()}' with error: ${_getString(error)}`;
            this.logger.error(message);
            throw new SnapshotError(message);
        }
    }
    */

    public async startPurgeSecondarySnapshotsOfDiskIdAndLocationOlderThan(
        resourceGroupName: string,
        diskId: string,
        location: string,
        baseDate: Date,
        days: number,
        requiredTag?: string
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

                    // Validate tag existence if requiredTag is provided
                    if (requiredTag && (!snapshot.tags || !(requiredTag in snapshot.tags))) {
                        this.logger.info(
                            `Skipping snapshot '${snapshot.name}' because required tag '${requiredTag}' does not exist.`
                        );
                        continue;
                    }

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

    /*
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

            const snapshotsToPurge = await this.graphManager.getSnapshotsBySourceAndDate(resourceGroupName, location, diskId, cutoff.toISOString());

            for await (const snapshot of snapshotsToPurge) {
                this.logger.info(
                    `Deleting primary snapshot '${snapshot.name}' for diskId '${diskId}' in location '${location}' created at ${snapshot.timeCreated}`
                );
                await this.computeClient.snapshots.beginDelete(resourceGroupName, snapshot.name);
                deletedSnapshots.push(snapshot.name);
            }
            return deletedSnapshots;
        } catch (error) {
            const message = `Unable to purge primary snapshots of diskId '${diskId}' in location '${location}' and resource group '${resourceGroupName}' older than ${days} days since '${baseDate.toISOString()}' with error: ${_getString(error)}`;
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
            
            // get disk name from disk id
            const diskName = extractDiskNameFromDiskId(diskId);

            const snapshotsToPurge = await this.graphManager.getSnapshotsByNameAndDate(resourceGroupName, location, diskName, cutoff.toISOString());

            for await (const snapshot of snapshotsToPurge) {
                this.logger.info(
                    `Deleting secondary snapshot '${snapshot.name}' for disk '${diskName}' in location '${location}' created at ${snapshot.timeCreated}`
                );
                await this.computeClient.snapshots.beginDelete(resourceGroupName, snapshot.name);
                deletedSnapshots.push(snapshot.name);
            }
            return deletedSnapshots;

        } catch (error) {
            const message = `Unable to purge secondary snapshots of diskId '${diskId}' in location '${location}' and resource group '${resourceGroupName}' older than ${days} days since '${baseDate.toISOString()}' with error: ${_getString(error)}`;
            this.logger.error(message);
            throw new SnapshotError(message);
        }
    }
    */


    public async startBulkPurgeSnapshotsOfDiskIdAndLocationOlderThan(
        resourceGroupName: string,
        diskId: string,
        location: string,
        baseDate: Date,
        days: number
    ): Promise<string[]> {
        const deletedSnapshots: string[] = [];
        try {
            const cutoff = new Date(baseDate.getTime() - days * 24 * 60 * 60 * 1000);
            
            // get disk name from disk id
            const diskName = extractDiskNameFromDiskId(diskId);

            const snapshotsToPurge = await this.graphManager.getSnapshotsByNameAndDate(resourceGroupName, location, diskName, cutoff.toISOString());

            for await (const snapshot of snapshotsToPurge) {
                
                this.logger.info(
                    `Deleting secondary snapshot '${snapshot.name}' for disk '${diskName}' in location '${location}' created at ${snapshot.timeCreated}`
                );
                await this.computeClient.snapshots.beginDelete(resourceGroupName, snapshot.name);
                deletedSnapshots.push(snapshot.name);
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
