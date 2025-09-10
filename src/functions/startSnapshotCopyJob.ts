import { app, InvocationContext } from "@azure/functions";

import { AzureLogger } from '../common/logger';
import { SnapshotCopy, SnapshotCopyControl, JobLogEntry } from "../common/interfaces";
import { SnapshotManager } from "../controllers/snapshot.manager";
import { LogManager } from "../controllers/log.manager";
import { QueueManager } from "../controllers/queue.manager";
import { ConcurrencyManager } from "../controllers/concurrency.manager";
import { _getString } from "../common/apperror";


export async function startSnapshotCopyJob(queueItem: SnapshotCopy, context: InvocationContext): Promise<void> {

    const logger = new AzureLogger(context);

    try {
        const logManager = new LogManager(logger);

        const concurrency = new ConcurrencyManager(process.env.AzureWebJobsStorage__accountname || "", process.env.AzureWebJobsStorage);
        const got = await concurrency.acquireSlot(100);

        if (!got) {
            logger.warn(`Copy concurrency limit reached. Re-scheduling copy for ${queueItem.primarySnapshot.id}`);
            const qm = new QueueManager(logger, process.env.AzureWebJobsStorage__accountname || "", 'copy-control');
            // requeue the control copy message with delay (exponential backoff)
            // set visibility/time to retry later (e.g., 60s or exponential based on attempt count)
            await qm.sendMessage(JSON.stringify(queueItem), 60*5); // 5 minutes
        } else {
            try {
                // A. Start snapshot copy to secondary region
                const snapshotManager = new SnapshotManager(logger, queueItem.primarySnapshot.subscriptionId);
                const secondarySnapshot = await snapshotManager.startCopySnapshotToAnotherRegion(queueItem.primarySnapshot, queueItem.secondaryLocation);
                const msgStartCopy = `Started snapshot copy ${queueItem.primarySnapshot.id} to location ${queueItem.secondaryLocation}`;
                logger.info(msgStartCopy);

                const logEntryStartCopy: JobLogEntry = {
                    jobId: queueItem.jobId,
                    jobStatus: 'Snapshot In Progress',
                    jobType: 'Snapshot',
                    sourceVmId: queueItem.sourceVmId,
                    sourceDiskId: queueItem.sourceDiskId,
                    jobOperation: 'Snapshot Copy Start',
                    message: msgStartCopy,
                    primarySnapshotId: queueItem.primarySnapshot.id,
                    primaryLocation: queueItem.primarySnapshot.location,
                    secondarySnapshotId: secondarySnapshot.id,
                    secondaryLocation: secondarySnapshot.location
                }
                await logManager.uploadLog(logEntryStartCopy);

                // B. Send control copy event with a visibility timeout of 1 hour
                const retryAfter = process.env.SNAPSHOT_RETRY_CONTROL_COPY_MINUTES ? parseInt(process.env.SNAPSHOT_RETRY_CONTROL_COPY_MINUTES) * 60 : 60*60; // 1 hour in seconds
                logger.info(`Sending control copy event for disk ID ${queueItem.sourceDiskId} and snapshot ID ${queueItem.primarySnapshot.id} with retry after ${retryAfter} seconds`);

                const snapshotControl: SnapshotCopyControl = {
                    control: {
                        jobId: queueItem.jobId,
                        sourceVmId: queueItem.sourceVmId,
                        sourceDiskId: queueItem.sourceDiskId,
                        primarySnapshotId: queueItem.primarySnapshot.id,
                        secondarySnapshotId: secondarySnapshot.id,
                        primaryLocation: queueItem.primarySnapshot.location,
                        secondaryLocation: secondarySnapshot.location
                    },
                    snapshot: secondarySnapshot
                };

                const queueManager = new QueueManager(logger, process.env.AzureWebJobsStorage__accountname || "", 'copy-control');
                await queueManager.sendMessage(JSON.stringify(snapshotControl), retryAfter);

            } catch (err) {
                // If start fails immediately, release slot so others can proceed
                await concurrency.releaseSlot();
                throw err;
            }
        }
    } catch (err) {
        logger.error(err);

        // End process
        const msgError = `Disk snapshot copy with job ID ${queueItem.jobId} for disk ID ${queueItem.sourceDiskId} failed with error ${_getString(err)}`;
        const logEntryError: JobLogEntry = {
            jobId: queueItem.jobId,
            jobOperation: 'Error',
            jobStatus: 'Snapshot Failed',
            jobType: 'Snapshot',
            message: msgError,
            sourceVmId: queueItem.sourceVmId,
            sourceDiskId: queueItem.sourceDiskId
        }
        const logManager = new LogManager(logger);
        await logManager.uploadLog(logEntryError);

        // This rethrown exception will only fail the individual invocation, instead of crashing the whole process
        throw err;
    }
}

app.storageQueue('startSnapshotCopyJob', {
    queueName: 'copy-jobs',
    connection: 'AzureWebJobsStorage',
    handler: startSnapshotCopyJob
});
