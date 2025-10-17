import { app, InvocationContext } from "@azure/functions";

import { AzureLogger } from '../common/logger';
import { BackupJobLogEntry, SnapshotPurge } from "../common/interfaces";
import { SnapshotManager } from "../controllers/snapshot.manager";
import { BackupLogManager } from "../controllers/log.manager";
import { QueueManager } from "../controllers/queue.manager";
import { _getString } from "../common/apperror";
import { QUEUE_PURGE_CONTROL, QUEUE_PURGE_JOBS, QUEUE_PURGE_SNAPSHOTS } from "../common/constants";
import { getRandomDelaySeconds } from "../common/utils";


export async function bckStartSnapshotPurgeJobOperations(queueItem: SnapshotPurge, context: InvocationContext): Promise<void> {

    const logger = new AzureLogger(context);

    try {
        const logManager = new BackupLogManager(logger);

        // A. Start old snapshots purge
        const snapshotManager = new SnapshotManager(logger, queueItem.subscriptionId);

        const snapshotBeingPurged = await snapshotManager.purgeSnapshot(
            queueItem.resourceGroupName,
            queueItem.snapshotNameToPurge
        );

        // Log the purge operation
        const msgPurge = `Started purging snapshot ${queueItem.snapshotNameToPurge}`;
        logger.info(msgPurge);

        const logEntryPurge: BackupJobLogEntry = {
            jobId: queueItem.source.jobId,
            jobOperation: 'Snapshot Purge Start',
            jobStatus: 'Purge In Progress',
            jobType: 'Purge',
            message: msgPurge,
            sourceVmId: queueItem.source.sourceVmId,
            sourceDiskId: queueItem.source.sourceDiskId,
            primarySnapshotId: queueItem.source.primarySnapshotId,
            primaryLocation: queueItem.source.primaryLocation,
            secondarySnapshotId: queueItem.source.secondarySnapshotId,
            secondaryLocation: queueItem.source.secondaryLocation
        }
        await logManager.uploadLog(logEntryPurge);

        // B. Send control purge event with a visibility timeout
        logger.info(`Sending control purge event for disk ID ${queueItem.source.sourceDiskId} in all locations`);

        // Prepare control purge event
        const queueManager = new QueueManager(logger, process.env.AzureWebJobsStorage__accountname || "", QUEUE_PURGE_CONTROL);
        const retryAfter = process.env.SMCP_BCK_RETRY_CONTROL_PURGE_MINUTES ? parseInt(process.env.SMCP_BCK_RETRY_CONTROL_PURGE_MINUTES)*60 : 60*60; // 1 hour in seconds

        await queueManager.sendMessage(JSON.stringify(queueItem), retryAfter);

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
                const maxRetryMsg = `Exceeded max retry attempts (20) for purge ${queueItem.source.primarySnapshotId}. Recording failure and not requeuing.`;
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
            logger.warn(`Too many requests limit reached. Re-scheduling purge for snapshots from vm ${queueItem.source.sourceVmId} (attempt ${attempt})`);

            const qm = new QueueManager(logger, process.env.AzureWebJobsStorage__accountname || "", QUEUE_PURGE_JOBS);

            // requeue the control purge message with delay (exponential backoff)
            // set visibility/time to retry later (e.g., 60s or exponential based on attempt count)
            const randomDelay = getRandomDelaySeconds(2, 5); 
            await qm.sendMessage(JSON.stringify(queueItem), randomDelay); // Delay in seconds

        } else {
            // Other error - just fail and log
            logger.error(err);

            // End process
            const msgError = `Snapshot ${queueItem.snapshotNameToPurge} purge job for disk ID ${queueItem.source.sourceDiskId} failed with error ${_getString(err)}`;
            const logEntryError: BackupJobLogEntry = {
                jobId: queueItem.source.jobId,
                jobOperation: 'Error',
                jobStatus: 'Purge Failed',
                jobType: 'Purge',
                message: msgError,
                sourceVmId: queueItem.source.sourceVmId,
                sourceDiskId: queueItem.source.sourceDiskId,
                primarySnapshotId: queueItem.source.primarySnapshotId,
                primaryLocation: queueItem.source.primaryLocation,
                secondarySnapshotId: queueItem.source.secondarySnapshotId,
                secondaryLocation: queueItem.source.secondaryLocation
            }
            const logManager = new BackupLogManager(logger);
            await logManager.uploadLog(logEntryError);

            // This rethrown exception will only fail the individual invocation, instead of crashing the whole process
            throw err;
        }
    }
}

app.storageQueue('bckStartSnapshotPurgeJobOperations', {
    queueName: QUEUE_PURGE_SNAPSHOTS,
    connection: 'AzureWebJobsStorage',
    handler: bckStartSnapshotPurgeJobOperations
});
