// Disk snapshots
import { ILogger } from '../common/logger';
import { ComputeManagementClient } from "@azure/arm-compute";
import { ResourceGraphManager } from "./graph.manager";
import { DefaultAzureCredential } from "@azure/identity";
import { SnapshotError, _getString } from "../common/apperror";
import { TAG_SMCP_LOCATION_TYPE, TAG_SMCP_SOURCE_DISK_ID } from "../common/constants";
import { SnapshotSource, Snapshot, VmRecoveryInfo, SnapshotCopyOptions } from "../common/interfaces";
import { formatDateYYYYMMDDTHHMM } from "../common/utils";
import { getSubscriptionAndResourceGroups } from '../common/azure-resource-utils';

 
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
                ipAddress: source.ipAddress,
                securityType: source.securityType
            };

            // Add mandatory tags from environment variable
            let allTags = {};
            const mandatoryTags = JSON.parse(process.env.SMCP_MANDATORY_TAGS || "[]");
            for (const tag of mandatoryTags) {
                if (tag.key && tag.value) {
                    allTags[tag.key] = tag.value;
                }
            }

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
                tags: { ...allTags,
                    "smcp-location-type": "primary",
                    "smcp-source-disk-id": source.diskId,
                    "smcp-src-subnet": source.subnetId, 
                    "smcp-recovery-info": JSON.stringify(recoveryInfo)
                }
            };

            // New snapshot name
            const snapshotName = `s${formatDateYYYYMMDDTHHMM(new Date())}-${source.diskName}`;

            // Create the snapshot
            const result = await this.computeClient.snapshots.beginCreateOrUpdateAndWait(
                process.env.SMCP_BCK_TARGET_RESOURCE_GROUP || source.resourceGroup,
                snapshotName,
                snapshotParams
            );

            // Map the result to the Snapshot interface
            const parsed = getSubscriptionAndResourceGroups(result.id);
            const snapshot: Snapshot = {
                id: result.id,
                name: result.name,
                location: result.location,
                resourceGroup: parsed.resourceGroups[0],
                subscriptionId: parsed.subscriptionId
            };

            // Return the created snapshot
            return snapshot;

        } catch (error) {
            const message = `Unable to create snapshot for disk '${source.diskName}' with error: ${_getString(error)}`;
            this.logger.error(message);
            throw new SnapshotError(message);
        }
    }


    public async startCopySnapshotToAnotherRegion(options: SnapshotCopyOptions): Promise<Snapshot> {

        try {
            const credential = new DefaultAzureCredential();
            const computeClient = new ComputeManagementClient(credential, options.sourceSnapshot.subscriptionId);

            // Get the source snapshot
            //const source = await computeClient.snapshots.get(sourceSnapshot.resourceGroup, sourceSnapshot.name);

            // Add mandatory tags from environment variable
            let allTags = {};
            const mandatoryTags = JSON.parse(process.env.SMCP_MANDATORY_TAGS || "[]");
            for (const tag of mandatoryTags) {
                if (tag.key && tag.value) {
                    allTags[tag.key] = tag.value;
                }
            }

            // Create the snapshot in the target region
            const targetSnapshotParams = {
                location: options.targetLocation,
                sku: {
                    name: "Standard_LRS"
                },
                creationData: {
                    createOption: "CopyStart",
                    sourceResourceId: options.sourceSnapshot.id // source.id // Use the source snapshot ID
                },
                incremental: true, // Set to true for incremental snapshot
                tags: { ...allTags,
                    "smcp-location-type": "secondary",
                    "smcp-source-disk-id": options.sourceDiskId,
                    "smcp-src-subnet": options.sourceSubnetId, 
                    "smcp-recovery-info": JSON.stringify(options.vmRecoveryInfo)
                }
            };

            const result = await computeClient.snapshots.beginCreateOrUpdate(
                options.sourceSnapshot.resourceGroup,
                `${options.sourceSnapshot.name}-sec`,
                targetSnapshotParams
            );

            return {
                id: `${options.sourceSnapshot.id}-sec`,
                name: `${options.sourceSnapshot.name}-sec`,
                location: options.targetLocation,
                resourceGroup: options.sourceSnapshot.resourceGroup,
                subscriptionId: options.sourceSnapshot.subscriptionId
            };

        } catch (error) {
            const message = `Unable to start copying snapshot '${options.sourceSnapshot.name}' to another region '${options.targetLocation}' with error: ${_getString(error)}`;
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
            // Create a date with only year, month, day from baseDate and set time to 23:59:59
            const baseDateEndOfDay = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), 23, 59, 59, 999);
            const primaryCutoff = new Date(baseDateEndOfDay.getTime() - primaryDays * 24 * 60 * 60 * 1000);
            const secondaryCutoff = new Date(baseDateEndOfDay.getTime() - secondaryDays * 24 * 60 * 60 * 1000);

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

    /**
     * Get all snapshots for a certain diskId tag to be purged.
     */
    public async GetSnapshotsOfDiskIdOlderThan(
        resourceGroupName: string,
        diskId: string,
        baseDate: Date,
        primaryDays: number,
        secondaryDays: number
    ): Promise<string[]> {
        
        try {
            // Create a date with only year, month, day from baseDate and set time to 23:59:59
            const baseDateEndOfDay = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), 23, 59, 59, 999);
            const primaryCutoff = new Date(baseDateEndOfDay.getTime() - primaryDays * 24 * 60 * 60 * 1000);
            const secondaryCutoff = new Date(baseDateEndOfDay.getTime() - secondaryDays * 24 * 60 * 60 * 1000);

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
            const result: string[] = []

            // Primary snapshots
            for (const snapshot of primaryCandidates) {
                result.push(snapshot.name);
            }

            // Secondary snapshots
            for (const snapshot of secondaryCandidates) {
                result.push(snapshot.name);
            }

            return result;
            
        } catch (error) {
            const message = `Unable to get the list of snapshots to purge for diskId '${diskId}' in resource group '${resourceGroupName}' in all locations with error: ${_getString(error)}`;
            this.logger.error(message);
            throw new SnapshotError(message);
        }
    }

    /**
     * Purge individual snapshots for a certain diskId tag.
     */
    public async purgeSnapshot(
        resourceGroupName: string,
        snapshotName: string
    ): Promise<string> {
        
        try {
            const result = await this.computeClient.snapshots.beginDelete(resourceGroupName, snapshotName);

            this.logger.info(`Deleted snapshot: ${snapshotName} ${result}`);

            return snapshotName;
        } catch (error) {
            const message = `Unable to purge snapshot '${snapshotName}' in resource group '${resourceGroupName}' in all locations with error: ${_getString(error)}`;
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
            } else {
                const message = `Unable to check if snapshot '${snapshotName}' is deleted with error: ${_getString(error)}`;
                this.logger.error(message);
                throw new SnapshotError(message);
            }
        }
    }

}
