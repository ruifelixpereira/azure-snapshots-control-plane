import { app, InvocationContext } from "@azure/functions";

import { AzureLogger } from '../common/logger';
import { SnapshotPurgeSource, SnapshotPurgeControl, JobLogEntry } from "../common/interfaces";
import { SnapshotManager } from "../controllers/snapshot.manager";
import { LogManager } from "../controllers/log.manager";
import { QueueManager } from "../controllers/queue.manager";
import { _getString } from "../common/apperror";
import { extractResourceGroupFromResourceId, extractSubscriptionIdFromResourceId } from "../common/utils";


export async function startSnapshotPurgeJob(queueItem: SnapshotPurgeSource, context: InvocationContext): Promise<void> {

    const logger = new AzureLogger(context);

    try {
        const logManager = new LogManager(logger);

        // Validate location
        if (queueItem.type !== 'primary' && queueItem.type !== 'secondary') {
            throw new Error(`Invalid queue item type: ${queueItem.type}. Expected 'primary' or 'secondary'.`);
        }

        // Get snapshots subscriptionId and resource group in primary/secondary location
        const subscriptionId = extractSubscriptionIdFromResourceId( queueItem.type === 'primary' ? queueItem.control.primarySnapshotId : queueItem.control.secondarySnapshotId);
        const resourceGroup = extractResourceGroupFromResourceId(queueItem.type === 'primary' ? queueItem.control.primarySnapshotId : queueItem.control.secondarySnapshotId);

        // A. Start old snapshots purge
        const snapshotManager = new SnapshotManager(logger, subscriptionId);

        const now = new Date();
        const primaryNumberOfDays = process.env.SNAPSHOT_PURGE_PRIMARY_LOCATION_NUMBER_OF_DAYS ? parseInt(process.env.SNAPSHOT_PURGE_PRIMARY_LOCATION_NUMBER_OF_DAYS) : 5;
        const secondaryNumberOfDays = process.env.SNAPSHOT_PURGE_SECONDARY_LOCATION_NUMBER_OF_DAYS ? parseInt(process.env.SNAPSHOT_PURGE_SECONDARY_LOCATION_NUMBER_OF_DAYS) : 30;
        const numberOfDays = queueItem.type === 'primary' ? primaryNumberOfDays : secondaryNumberOfDays;
        
        logger.info(`Start purging snapshots for disk ID ${queueItem.control.sourceDiskId} in ${queueItem.type} location ${queueItem.type === 'primary' ? queueItem.control.primaryLocation : queueItem.control.secondaryLocation}`);

        let snapshotsBeingPurged: string[] = [];
        if (queueItem.type === 'primary') {
            snapshotsBeingPurged = await snapshotManager.startPurgePrimarySnapshotsOfDiskIdAndLocationOlderThan(
                resourceGroup,
                queueItem.control.sourceDiskId,
                queueItem.control.primaryLocation,
                now,
                numberOfDays
            );
        } else {
            snapshotsBeingPurged = await snapshotManager.startPurgeSecondarySnapshotsOfDiskIdAndLocationOlderThan(
                resourceGroup,
                queueItem.control.sourceDiskId,
                queueItem.control.secondaryLocation,
                now,
                numberOfDays
            );
        }

        // Prepare control purge event
        const queueManager = new QueueManager(logger, process.env.AzureWebJobsStorage || "", 'purge-control');
        const retryAfter = process.env.SNAPSHOT_RETRY_CONTROL_PURGE_MINUTES ? parseInt(process.env.SNAPSHOT_RETRY_CONTROL_PURGE_MINUTES)*60 : 60*60; // 1 hour in seconds

        if (snapshotsBeingPurged.length > 0) {
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
        const msgError = `Snapshot purge job for disk ID ${queueItem.control.sourceDiskId} failed with error ${_getString(err)}`;
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

app.storageQueue('startSnapshotPurgeJob', {
    queueName: 'purge-jobs',
    connection: 'AzureWebJobsStorage',
    handler: startSnapshotPurgeJob
});
