import { app, InvocationContext } from "@azure/functions";

import { AzureLogger } from '../common/logger';
import { SnapshotControl, SnapshotPurgeControl, JobLogEntry } from "../common/interfaces";
import { SnapshotManager } from "../controllers/snapshot.manager";
import { LogManager } from "../controllers/log.manager";
import { QueueManager } from "../controllers/queue.manager";
import { _getString } from "../common/apperror";
import { extractResourceGroupFromResourceId, extractSubscriptionIdFromResourceId } from "../common/utils";


export async function startSnapshotPurgeJob(queueItem: SnapshotControl, context: InvocationContext): Promise<void> {

    const logger = new AzureLogger(context);

    try {
        const logManager = new LogManager(logger);

        // Get snapshots subscriptionId and resource group in primary/secondary location
        const subscriptionId = extractSubscriptionIdFromResourceId(queueItem.sourceDiskId);
        const resourceGroup = extractResourceGroupFromResourceId(queueItem.sourceDiskId);

        // A. Start old snapshots purge
        const snapshotManager = new SnapshotManager(logger, subscriptionId);

        const now = new Date();
        const primaryNumberOfDays = process.env.SNAPSHOT_PURGE_PRIMARY_LOCATION_NUMBER_OF_DAYS ? parseInt(process.env.SNAPSHOT_PURGE_PRIMARY_LOCATION_NUMBER_OF_DAYS) : 5;
        const secondaryNumberOfDays = process.env.SNAPSHOT_PURGE_SECONDARY_LOCATION_NUMBER_OF_DAYS ? parseInt(process.env.SNAPSHOT_PURGE_SECONDARY_LOCATION_NUMBER_OF_DAYS) : 30;
        
        logger.info(`Start purging snapshots for disk ID ${queueItem.sourceDiskId} in all locations`);

        const snapshotsBeingPurged = await snapshotManager.startPurgeSnapshotsOfDiskIdOlderThan(
            resourceGroup,
            queueItem.sourceDiskId,
            now,
            primaryNumberOfDays,
            secondaryNumberOfDays
        );

        if (snapshotsBeingPurged.length > 0) {

            // Prepare control purge event
            const queueManager = new QueueManager(logger, process.env.AzureWebJobsStorage__accountname || "", 'purge-control');
            const retryAfter = process.env.SNAPSHOT_RETRY_CONTROL_PURGE_MINUTES ? parseInt(process.env.SNAPSHOT_RETRY_CONTROL_PURGE_MINUTES)*60 : 60*60; // 1 hour in seconds

            // Log the purge operation
            const msgPurge = `Started purging snapshots for disk ID ${queueItem.sourceDiskId} in all locations`;
            logger.info(msgPurge);

            const logEntryPurge: JobLogEntry = {
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

            // B. Send control purge event with a visibility timeout
            logger.info(`Sending control purge event for disk ID ${queueItem.sourceDiskId} in all locations`);

            const purgeControl: SnapshotPurgeControl = {
                source: queueItem,
                snapshotsNameToPurge: snapshotsBeingPurged
            };

            await queueManager.sendMessage(JSON.stringify(purgeControl), retryAfter);
        }

    } catch (err) {
        logger.error(err);

        // End process
        const msgError = `Snapshot purge job for disk ID ${queueItem.sourceDiskId} failed with error ${_getString(err)}`;
        const logEntryError: JobLogEntry = {
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
        const logManager = new LogManager(logger);
        await logManager.uploadLog(logEntryError);

        // This rethrown exception will only fail the individual invocation, instead of crashing the whole process
        throw err;
    }
}

app.storageQueue('startSnapshotPurgeJob', {
    queueName: 'purge-jobs',
    connection: 'AzureWebJobsStorage',
    handler: startSnapshotPurgeJob
});
