// Disk snapshots
import { ILogger } from '../common/logger';
import { ComputeManagementClient } from "@azure/arm-compute";
import { ResourceGraphManager } from "./graph.manager";
import { DefaultAzureCredential } from "@azure/identity";
import { SnapshotError, _getString } from "../common/apperror";
import { TAG_SMCP_LOCATION_TYPE, TAG_SMCP_SOURCE_DISK_ID } from "../common/constants";
import { SnapshotSource, Snapshot, VmRecoveryInfo } from "../common/interfaces";
import { formatDateYYYYMMDDTHHMM } from "../common/utils";

 
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
            // Compose VM recovery info
            const recoveryInfo: VmRecoveryInfo = {
                vmName: source.vmName,
                vmSize: source.vmSize,
                diskSku: source.diskSku,
                diskProfile: source.diskProfile,
                ipAddress: source.ipAddress
            };  

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
                    "smcp-location-type": "primary",
                    "smcp-source-disk-id": source.diskId,
                    "smcp-recovery-info": JSON.stringify(recoveryInfo)
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


    public async startCopySnapshotToAnotherRegion(sourceDiskId: string, sourceSnapshot: Snapshot, targetLocation: string, vmRecoveryInfo: VmRecoveryInfo): Promise<Snapshot> {

        try {
            const credential = new DefaultAzureCredential();
            const computeClient = new ComputeManagementClient(credential, sourceSnapshot.subscriptionId);

            // Get the source snapshot
            //const source = await computeClient.snapshots.get(sourceSnapshot.resourceGroup, sourceSnapshot.name);

            // Create the snapshot in the target region
            const targetSnapshotParams = {
                location: targetLocation,
                sku: {
                    name: "Standard_LRS"
                },
                creationData: {
                    createOption: "CopyStart",
                    sourceResourceId: sourceSnapshot.id // source.id // Use the source snapshot ID
                },
                incremental: true, // Set to true for incremental snapshot
                tags: { 
                    "smcp-location-type": "secondary",
                    "smcp-source-disk-id": sourceDiskId,
                    "smcp-recovery-info": JSON.stringify(vmRecoveryInfo)
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

            // Safely read completionPercent (may be undefined or a string)
            const rawCompletion = (snapshot as any)?.completionPercent;
            const parsedCompletion = rawCompletion == null ? undefined : Number(rawCompletion);
            const copyStatus = (parsedCompletion !== undefined && Number.isFinite(parsedCompletion)) ? parsedCompletion : undefined;

            const provisioningState = snapshot.provisioningState;

            if (copyStatus === 100 && provisioningState === "Succeeded") {
                return "Succeeded";
            } else if (provisioningState === "Failed") {
                return "Failed";
            } else {
                return "InProgress";
            }
        
        } catch (error) {
            const message = `Unable to check snapshot copy status for '${snapshotName}' with error: ${_getString(error)}`;
            this.logger.error(message);
            throw new SnapshotError(message);
        }
    }


    /**
     * Purge all snapshots for a certain diskId tag.
     */
    public async startPurgeSnapshotsOfDiskIdOlderThan(
        resourceGroupName: string,
        diskId: string,
        baseDate: Date,
        primaryDays: number,
        secondaryDays: number
    ): Promise<string[]> {
        
        try {
            const primaryCutoff = new Date(baseDate.getTime() - primaryDays * 24 * 60 * 60 * 1000);
            const secondaryCutoff = new Date(baseDate.getTime() - secondaryDays * 24 * 60 * 60 * 1000);

            // List all snapshots in the resource group
            const allSnapshots: Array<any> = [];
            for await (const s of this.computeClient.snapshots.listByResourceGroup(resourceGroupName)) {
                allSnapshots.push(s);
            }

            // Filter snapshots that are for the desired disk
            const candidateSnapshots = allSnapshots.filter((snapshot: any) =>
                snapshot.timeCreated &&
                snapshot.tags &&
                snapshot.tags[TAG_SMCP_LOCATION_TYPE] &&
                snapshot.tags[TAG_SMCP_SOURCE_DISK_ID] &&
                snapshot.tags[TAG_SMCP_SOURCE_DISK_ID].toLowerCase() === diskId.toLowerCase()
            );

            // Filter snapshots that are primary for the desired disk and older than cutoff
            const primaryCandidates = candidateSnapshots.filter((snapshot: any) =>
                new Date(snapshot.timeCreated) < primaryCutoff &&
                snapshot.tags[TAG_SMCP_LOCATION_TYPE].toLowerCase() === 'primary'
            );

            // Filter snapshots that are secondary for the desired disk and older than cutoff
            const secondaryCandidates = candidateSnapshots.filter((snapshot: any) =>
                new Date(snapshot.timeCreated) < secondaryCutoff &&
                snapshot.tags[TAG_SMCP_LOCATION_TYPE].toLowerCase() === 'secondary'
            );

            this.logger.info(`Found ${primaryCandidates.length} primary and ${secondaryCandidates.length} secondary candidate snapshots for diskId '${diskId}' in resource group '${resourceGroupName}' to purge`);

            // Start purging snapshots
            const promises: Promise<any>[] = []

            // Primary snapshots
            for (const snapshot of primaryCandidates) {
                promises.push(this.computeClient.snapshots.beginDelete(resourceGroupName, snapshot.name));
            }

            // Secondary snapshots
            for (const snapshot of secondaryCandidates) {
                promises.push(this.computeClient.snapshots.beginDelete(resourceGroupName, snapshot.name));
            }

            await Promise.all(promises);
            const deletedSnapshots: string[] = primaryCandidates.map(s => s.name).concat(secondaryCandidates.map(s => s.name));
            this.logger.info(`Deleted snapshots: ${deletedSnapshots.join(", ")}`);

            return deletedSnapshots;
        } catch (error) {
            const message = `Unable to purge snapshots of diskId '${diskId}' in resource group '${resourceGroupName}' in all locations with error: ${_getString(error)}`;
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
