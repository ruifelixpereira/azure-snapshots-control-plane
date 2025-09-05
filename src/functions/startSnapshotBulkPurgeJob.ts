import { app, InvocationContext } from "@azure/functions";

import { AzureLogger } from '../common/logger';
import { SnapshotPurgeSource, SnapshotPurgeControl, JobLogEntry } from "../common/interfaces";
import { SnapshotManager } from "../controllers/snapshot.manager";
import { LogManager } from "../controllers/log.manager";
import { QueueManager } from "../controllers/queue.manager";
import { _getString } from "../common/apperror";
import { extractResourceGroupFromResourceId, extractSubscriptionIdFromResourceId } from "../common/utils";


export async function startSnapshotBulkPurgeJob(queueItem: SnapshotPurgeSource, context: InvocationContext): Promise<void> {

    const logger = new AzureLogger(context);

    try {
        const logManager = new LogManager(logger);

        // Validate location
        if (queueItem.type !== 'primary' && queueItem.type !== 'secondary') {
            throw new Error(`Invalid queue item type: ${queueItem.type}. Expected 'primary' or 'secondary'.`);
        }

        // Validate bulk operation
        if (queueItem.control.primarySnapshotId !== 'all' && queueItem.control.secondarySnapshotId !== 'all') {
            throw new Error(`Invalid bulk operation: ${queueItem.control.primarySnapshotId}, ${queueItem.control.secondarySnapshotId}. Expected 'all' in the primary or secondary snapshot id.`);
        }

        // Get snapshots subscriptionId and resource group in primary/secondary location
        const subscriptionId = extractSubscriptionIdFromResourceId(queueItem.control.sourceDiskId);
        const resourceGroup = extractResourceGroupFromResourceId(queueItem.control.sourceDiskId);

        // A. Start old snapshots purge
        const snapshotManager = new SnapshotManager(logger, subscriptionId);

        const now = new Date();
        const numberOfDays = 0;
        
        logger.info(`Start bulk purging snapshots for disk ID ${queueItem.control.sourceDiskId} in ${queueItem.type} location ${queueItem.type === 'primary' ? queueItem.control.primaryLocation : queueItem.control.secondaryLocation}`);

        const snapshotsBeingPurged = await snapshotManager.startBulkPurgeSnapshotsOfDiskIdAndLocationOlderThan(
            resourceGroup,
            queueItem.control.sourceDiskId,
            queueItem.type === 'primary' ? queueItem.control.primaryLocation : queueItem.control.secondaryLocation,
            now,
            numberOfDays
        );

        if (snapshotsBeingPurged.length > 0) {

            // Prepare control purge event
            const queueManager = new QueueManager(logger, process.env.AzureWebJobsStorage__accountname || "", 'purge-control');
            const retryAfter = process.env.SNAPSHOT_RETRY_CONTROL_PURGE_MINUTES ? parseInt(process.env.SNAPSHOT_RETRY_CONTROL_PURGE_MINUTES)*60 : 60*60; // 1 hour in seconds

            // Log the purge operation
            const msgPurge = `Started purging snapshots for disk ID ${queueItem.control.sourceDiskId} in ${queueItem.type} location ${queueItem.type === 'primary' ? queueItem.control.primaryLocation : queueItem.control.secondaryLocation}`;
            logger.info(msgPurge);

            const logEntryPurge: JobLogEntry = {
                jobId: queueItem.control.jobId,
                jobOperation: `${queueItem.type === 'primary' ? 'Primary' : 'Secondary'} Snapshot Purge Start`,
                jobStatus: 'Purge In Progress',
                jobType: 'Purge',
                message: msgPurge,
                sourceVmId: queueItem.control.sourceVmId,
                sourceDiskId: queueItem.control.sourceDiskId,
                primarySnapshotId: queueItem.control.primarySnapshotId,
                primaryLocation: queueItem.control.primaryLocation,
                secondarySnapshotId: queueItem.control.secondarySnapshotId,
                secondaryLocation: queueItem.control.secondaryLocation
            }
            await logManager.uploadLog(logEntryPurge);

            // B. Send control purge event with a visibility timeout
            logger.info(`Sending control purge event for disk ID ${queueItem.control.sourceDiskId} in ${queueItem.type} location ${queueItem.type === 'primary' ? queueItem.control.primaryLocation : queueItem.control.secondaryLocation}`);

            const purgeControl: SnapshotPurgeControl = {
                source: queueItem,
                baseDate: now,
                daysToKeep: numberOfDays,
                snapshotsNameToPurge: snapshotsBeingPurged
            };

            await queueManager.sendMessage(JSON.stringify(purgeControl), retryAfter);
        }

    } catch (err) {
        logger.error(err);

        // End process
        const msgError = `Snapshot bulk purge job for disk ID ${queueItem.control.sourceDiskId} failed with error ${_getString(err)}`;
        const logEntryError: JobLogEntry = {
            jobId: queueItem.control.jobId,
            jobOperation: 'Error',
            jobStatus: 'Purge Failed',
            jobType: 'Purge',
            message: msgError,
            sourceVmId: queueItem.control.sourceVmId,
            sourceDiskId: queueItem.control.sourceDiskId,
            primarySnapshotId: queueItem.control.primarySnapshotId,
            primaryLocation: queueItem.control.primaryLocation,
            secondarySnapshotId: queueItem.control.secondarySnapshotId,
            secondaryLocation: queueItem.control.secondaryLocation
        }
        const logManager = new LogManager(logger);
        await logManager.uploadLog(logEntryError);

        // This rethrown exception will only fail the individual invocation, instead of crashing the whole process
        throw err;
    }
}

app.storageQueue('startSnapshotBulkPurgeJob', {
    queueName: 'bulk-purge-jobs',
    connection: 'AzureWebJobsStorage',
    handler: startSnapshotBulkPurgeJob
});
