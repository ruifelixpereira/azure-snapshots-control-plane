import { app, InvocationContext, output } from "@azure/functions";

import { AzureLogger } from '../common/logger';
import { SnapshotControl, BackupJobLogEntry, SnapshotPurge } from "../common/interfaces";
import { SnapshotManager } from "../controllers/snapshot.manager";
import { BackupLogManager } from "../controllers/log.manager";
import { QueueManager } from "../controllers/queue.manager";
import { _getString } from "../common/apperror";
import { getSubscriptionAndResourceGroup } from '../common/azure-resource-utils';
import { QUEUE_PURGE_JOBS, QUEUE_PURGE_SNAPSHOTS } from "../common/constants";
import { extractVmNameFromResourceId, getRandomDelaySeconds } from "../common/utils";


const purgeSnapshotsQueueOutput = output.storageQueue({
    queueName: QUEUE_PURGE_SNAPSHOTS,
    connection: 'AzureWebJobsStorage'
});


export async function bckStartSnapshotPurgeJob(queueItem: SnapshotControl, context: InvocationContext): Promise<void> {

    const logger = new AzureLogger(context);

    try {
        const logManager = new BackupLogManager(logger);

        // Get snapshots subscriptionId and resource group in primary/secondary location
        const parsed = getSubscriptionAndResourceGroup(queueItem.primarySnapshotId);

        // A. Start old snapshots purge
        const snapshotManager = new SnapshotManager(logger, parsed.subscriptionId);

        const now = new Date();
        let primaryNumberOfDays = process.env.SMCP_BCK_PURGE_PRIMARY_LOCATION_NUMBER_OF_DAYS ? parseInt(process.env.SMCP_BCK_PURGE_PRIMARY_LOCATION_NUMBER_OF_DAYS) : 5;
        let secondaryNumberOfDays = process.env.SMCP_BCK_PURGE_SECONDARY_LOCATION_NUMBER_OF_DAYS ? parseInt(process.env.SMCP_BCK_PURGE_SECONDARY_LOCATION_NUMBER_OF_DAYS) : 30;

        // Check Test use cases
        const vmName = extractVmNameFromResourceId(queueItem.sourceVmId);
        if (vmName.toLowerCase() === (process.env.UC01_VM_NAME || "").toLowerCase()) {
            primaryNumberOfDays = process.env.UC01_BCK_PURGE_PRIMARY_LOCATION_NUMBER_OF_DAYS ? parseInt(process.env.UC01_BCK_PURGE_PRIMARY_LOCATION_NUMBER_OF_DAYS) : 0;
            secondaryNumberOfDays = process.env.UC01_BCK_PURGE_SECONDARY_LOCATION_NUMBER_OF_DAYS ? parseInt(process.env.UC01_BCK_PURGE_SECONDARY_LOCATION_NUMBER_OF_DAYS) : 7;
        } else if (vmName.toLowerCase() === (process.env.UC02_VM_NAME || "").toLowerCase()) {
            primaryNumberOfDays = process.env.UC02_BCK_PURGE_PRIMARY_LOCATION_NUMBER_OF_DAYS ? parseInt(process.env.UC02_BCK_PURGE_PRIMARY_LOCATION_NUMBER_OF_DAYS) : 1;
            secondaryNumberOfDays = process.env.UC02_BCK_PURGE_SECONDARY_LOCATION_NUMBER_OF_DAYS ? parseInt(process.env.UC02_BCK_PURGE_SECONDARY_LOCATION_NUMBER_OF_DAYS) : 7;
        } else if (vmName.toLowerCase() === (process.env.UC03_VM_NAME || "").toLowerCase()) {
            primaryNumberOfDays = process.env.UC03_BCK_PURGE_PRIMARY_LOCATION_NUMBER_OF_DAYS ? parseInt(process.env.UC03_BCK_PURGE_PRIMARY_LOCATION_NUMBER_OF_DAYS) : 1;
            secondaryNumberOfDays = process.env.UC03_BCK_PURGE_SECONDARY_LOCATION_NUMBER_OF_DAYS ? parseInt(process.env.UC03_BCK_PURGE_SECONDARY_LOCATION_NUMBER_OF_DAYS) : 7;
        }
        
        logger.info(`Start purging snapshots for disk ID ${queueItem.sourceDiskId} in all locations`);

        const snapshotsBeingPurged = await snapshotManager.GetSnapshotsOfDiskIdOlderThan(
            parsed.resourceGroupName,
            queueItem.sourceDiskId,
            now,
            primaryNumberOfDays,
            secondaryNumberOfDays
        );

        if (snapshotsBeingPurged.length > 0) {

            // Log the purge operation
            const msgPurge = `Started purging ${snapshotsBeingPurged.length} snapshots for disk ID ${queueItem.sourceDiskId} in all locations`;
            logger.info(msgPurge);

            const logEntryPurge: BackupJobLogEntry = {
                jobId: queueItem.jobId,
                jobOperation: 'Snapshot Purge Start',
                jobStatus: 'Purge In Progress',
                jobType: 'Purge',
                message: msgPurge,
                sourceVmId: queueItem.sourceVmId,
                sourceDiskId: queueItem.sourceDiskId,
                primarySnapshotId: queueItem.primarySnapshotId,
                primaryLocation: queueItem.primaryLocation,
                secondarySnapshotId: queueItem.secondarySnapshotId,
                secondaryLocation: queueItem.secondaryLocation
            }
            await logManager.uploadLog(logEntryPurge);

            // B. Send purge individual snapshot event
            logger.info(`Sending individual purge events for disk ID ${queueItem.sourceDiskId} in all locations`);

            // Prepare individual purge events
            const snapshotsToPurge: SnapshotPurge[] = snapshotsBeingPurged.map(snapshot => ({
                source: queueItem,
                subscriptionId: parsed.subscriptionId,
                resourceGroupName: parsed.resourceGroupName,
                snapshotNameToPurge: snapshot
            }));

            // Send notification using Storage Queue
            context.extraOutputs.set(purgeSnapshotsQueueOutput, snapshotsToPurge);
        }

    } catch (err) {

        const errMsg = _getString(err);

        // Detect too many requests limit error (service message)
        const isTooManyRequestsLimitError = /too many requests|Please try after|Please retry the request later|The service is unavailable now/i.test(errMsg);

        if (isTooManyRequestsLimitError) {
            // attempt counter kept inside payload
            const attempt = ((queueItem as any).attempt ?? 0) + 1;
            (queueItem as any).attempt = attempt;

            /*
            if (attempt > 20) {
                // Max attempts reached
                const maxRetryMsg = `Exceeded max retry attempts (20) for purge ${queueItem.primarySnapshot.id}. Recording failure and not requeuing.`;
                logger.error(maxRetryMsg);

                // End process
                const logEntryError: BackupJobLogEntry = {
                    jobId: queueItem.jobId,
                    jobOperation: 'Error',
                    jobStatus: 'Purge Failed',
                    jobType: 'Purge',
                    message: maxRetryMsg,
                    sourceVmId: queueItem.sourceVmId,
                    sourceDiskId: queueItem.sourceDiskId
                }
                const BackupLogManager = new BackupLogManager(logger);
                await BackupLogManager.uploadLog(logEntryError);                
                
                throw err;
            }
            */

            // Requeue the copy message with delay
            logger.warn(`Too many requests limit reached. Re-scheduling purge for snapshots from vm ${queueItem.sourceVmId} (attempt ${attempt})`);

            const qm = new QueueManager(logger, process.env.AzureWebJobsStorage__accountname || "", QUEUE_PURGE_JOBS);

            // requeue the control purge message with delay (exponential backoff)
            // set visibility/time to retry later (e.g., 60s or exponential based on attempt count)
            const randomDelay = getRandomDelaySeconds(2, 5); 
            await qm.sendMessage(JSON.stringify(queueItem), randomDelay); // Delay in seconds

        } else {
            // Other error - just fail and log
            logger.error(err);

            // End process
            const msgError = `Snapshot purge job for disk ID ${queueItem.sourceDiskId} failed with error ${_getString(err)}`;
            const logEntryError: BackupJobLogEntry = {
                jobId: queueItem.jobId,
                jobOperation: 'Error',
                jobStatus: 'Purge Failed',
                jobType: 'Purge',
                message: msgError,
                sourceVmId: queueItem.sourceVmId,
                sourceDiskId: queueItem.sourceDiskId,
                primarySnapshotId: queueItem.primarySnapshotId,
                primaryLocation: queueItem.primaryLocation,
                secondarySnapshotId: queueItem.secondarySnapshotId,
                secondaryLocation: queueItem.secondaryLocation
            }
            const logManager = new BackupLogManager(logger);
            await logManager.uploadLog(logEntryError);

            // This rethrown exception will only fail the individual invocation, instead of crashing the whole process
            throw err;
        }
    }
}

app.storageQueue('bckStartSnapshotPurgeJob', {
    queueName: QUEUE_PURGE_JOBS,
    connection: 'AzureWebJobsStorage',
    extraOutputs: [
        purgeSnapshotsQueueOutput
    ],
    handler: bckStartSnapshotPurgeJob
});
