import { app, InvocationContext, output } from "@azure/functions";

import { AzureLogger } from '../common/logger';
import { SnapshotCopyControl, JobLogEntry } from "../common/interfaces";
import { SnapshotManager } from "../controllers/snapshot.manager";
import { LogManager } from "../controllers/log.manager";
import { QueueManager } from "../controllers/queue.manager";
import { _getString } from "../common/apperror";


const purgeJobsQueueOutput = output.storageQueue({
    queueName: 'purge-jobs',
    connection: 'AzureWebJobsStorage'
});


export async function controlSnapshotCopy(queueItem: SnapshotCopyControl, context: InvocationContext): Promise<void> {

    const logger = new AzureLogger(context);

    try {
        const logManager = new LogManager(logger);
        logger.info(`Checking the snapshot copy for snapshot ID ${queueItem.snapshot.id}`);

        // A. Check if snapshot copy already finished
        const snapshotManager = new SnapshotManager(logger, queueItem.snapshot.subscriptionId);
        const currentState = await snapshotManager.getSnapshotCopyState(queueItem.snapshot.resourceGroup, queueItem.snapshot.name);
        if (currentState === "Succeeded") {
            const msgCopyFinished = `Snapshot copy finished for snapshot ID ${queueItem.snapshot.id}`;
            logger.info(msgCopyFinished);

            const logEntryCopyFinished: JobLogEntry = {
                jobId: queueItem.control.jobId,
                jobOperation: 'Snapshot Copy End',
                jobStatus: 'Snapshot Completed',
                jobType: 'Snapshot',
                message: msgCopyFinished,
                sourceVmId: queueItem.control.sourceVmId,
                sourceDiskId: queueItem.control.sourceDiskId,
                primarySnapshotId: queueItem.control.primarySnapshotId,
                primaryLocation: queueItem.control.primaryLocation,
                secondarySnapshotId: queueItem.control.secondarySnapshotId,
                secondaryLocation: queueItem.control.secondaryLocation
            }
            await logManager.uploadLog(logEntryCopyFinished);

            // C. Trigger old snapshots purge in primary and secondary location
            logger.info(`Sending trigger message to start purge event for disk ID ${queueItem.control.sourceDiskId} in primary location ${queueItem.control.primaryLocation} and secondary location ${queueItem.control.secondaryLocation}`);

            // Send notifications using Storage Queue
            const queueItemControl = queueItem.control;
            context.extraOutputs.set(purgeJobsQueueOutput, queueItemControl);

        } else if (currentState === "Failed") {
           
            const msgCopyFailed = `Snapshot copy failed for snapshot ID ${queueItem.snapshot.id}`;
            logger.error(msgCopyFailed);
            const logEntryCopyFailed: JobLogEntry = {
                jobId: queueItem.control.jobId,
                jobOperation: 'Error',
                jobStatus: 'Snapshot Failed',
                jobType: 'Snapshot',
                message: msgCopyFailed,
                sourceVmId: queueItem.control.sourceVmId,
                sourceDiskId: queueItem.control.sourceDiskId,
                primarySnapshotId: queueItem.control.primarySnapshotId,
                primaryLocation: queueItem.control.primaryLocation,
                secondarySnapshotId: queueItem.control.secondarySnapshotId,
                secondaryLocation: queueItem.control.secondaryLocation
            }
            const logManager = new LogManager(logger);
            await logManager.uploadLog(logEntryCopyFailed);
        } else {
            // B. Copy still in progress
            // Re-send control copy event with a visibility timeout of 1 hour
            const retryAfter = process.env.SNAPSHOT_RETRY_CONTROL_COPY_MINUTES ? parseInt(process.env.SNAPSHOT_RETRY_CONTROL_COPY_MINUTES)*60 : 60*60; // 1 hour in seconds
            logger.info(`Snapshot copy still in progress. Re-sending control copy event for snapshot ID ${queueItem.snapshot.id} with retry after ${retryAfter} seconds`);
            const queueManager = new QueueManager(logger, process.env.AzureWebJobsStorage__accountname || "", 'copy-control');
            await queueManager.sendMessage(JSON.stringify(queueItem), retryAfter);
        }

    } catch (err) {
        logger.error(err);

        // End process
        const msgError = `Snapshot copy control for disk ID ${queueItem.control.sourceDiskId} and snapshot ID ${queueItem.control.primarySnapshotId} failed with error ${_getString(err)}`;
        const logEntryError: JobLogEntry = {
            jobId: queueItem.control.jobId,
            jobOperation: 'Error',
            jobStatus: 'Snapshot Failed',
            jobType: 'Snapshot',
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

app.storageQueue('controlSnapshotCopy', {
    queueName: 'copy-control',
    connection: 'AzureWebJobsStorage',
    extraOutputs: [
        purgeJobsQueueOutput
    ],
    handler: controlSnapshotCopy
});
