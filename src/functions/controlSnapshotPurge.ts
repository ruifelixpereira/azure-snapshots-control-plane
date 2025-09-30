import { app, InvocationContext } from "@azure/functions";

import { AzureLogger } from '../common/logger';
import { SnapshotPurgeControl, JobLogEntry } from "../common/interfaces";
import { SnapshotManager } from "../controllers/snapshot.manager";
import { LogManager } from "../controllers/log.manager";
import { QueueManager } from "../controllers/queue.manager";
import { _getString } from "../common/apperror";
import { getSubscriptionAndResourceGroup } from '../common/azure-resource-utils';


export async function controlSnapshotPurge(queueItem: SnapshotPurgeControl, context: InvocationContext): Promise<void> {

    const logger = new AzureLogger(context);

    try {
        const logManager = new LogManager(logger);
        logger.info(`Checking the snapshot purge for disk ID ${queueItem.source.sourceDiskId} in all locations`);

        // Get snapshots subscriptionId and resource group in primary/secondary location
        const parsed = getSubscriptionAndResourceGroup(queueItem.source.primarySnapshotId);

        // A. Check if snapshot purge already finished
        const snapshotManager = new SnapshotManager(logger, parsed.subscriptionId);

        const snapshotsFinished = await snapshotManager.areSnapshotsDeleted(parsed.resourceGroupName, queueItem.snapshotsNameToPurge);
        const finished = Object.values(snapshotsFinished).every(v => v === true);

        if (finished) {
            // Purge is done
            const msgPurgeFinished = `Snapshot purge finished for disk ID ${queueItem.source.sourceDiskId}`;
            logger.info(msgPurgeFinished);

            const logEntryPurgeFinished: JobLogEntry = {
                jobId: queueItem.source.jobId,
                jobOperation: 'Snapshot Purge End',
                jobStatus: 'Purge Completed',
                jobType: 'Purge',
                message: msgPurgeFinished,
                sourceVmId: queueItem.source.sourceVmId,
                sourceDiskId: queueItem.source.sourceDiskId,
                primarySnapshotId: queueItem.source.primarySnapshotId,
                primaryLocation: queueItem.source.primaryLocation,
                secondarySnapshotId: queueItem.source.secondarySnapshotId,
                secondaryLocation: queueItem.source.secondaryLocation
            }
            await logManager.uploadLog(logEntryPurgeFinished);

        } else {
            // B. Still in progress

            // Re-send control purge event with a visibility timeout of 1 hour
            const retryAfter = process.env.SNAPSHOT_RETRY_CONTROL_PURGE_MINUTES ? parseInt(process.env.SNAPSHOT_RETRY_CONTROL_PURGE_MINUTES)*60 : 60*60; // 1 hour in seconds
            logger.info(`Snapshot purge still in progress. Re-sending control purge event for disk ID ${queueItem.source.sourceDiskId} with retry after ${retryAfter} seconds`);
            const queueManager = new QueueManager(logger, process.env.AzureWebJobsStorage__accountname || "", 'purge-control');
            await queueManager.sendMessage(JSON.stringify(queueItem), retryAfter);
        }

    } catch (err) {
        logger.error(err);

        // End process
        const msgError = `Snapshot purge control for disk ID ${queueItem.source.sourceDiskId} failed with error ${_getString(err)}`;
        const logEntryError: JobLogEntry = {
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
        const logManager = new LogManager(logger);
        await logManager.uploadLog(logEntryError);

        // This rethrown exception will only fail the individual invocation, instead of crashing the whole process
        throw err;
    }
}

app.storageQueue('controlSnapshotPurge', {
    queueName: 'purge-control',
    connection: 'AzureWebJobsStorage',
    handler: controlSnapshotPurge
});
