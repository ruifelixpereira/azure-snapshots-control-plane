import { app, InvocationContext } from "@azure/functions";

import { AzureLogger } from '../common/logger';
import { SnapshotCopy, SnapshotCopyControl, BackupJobLogEntry } from "../common/interfaces";
import { SnapshotManager } from "../controllers/snapshot.manager";
import { BackupLogManager } from "../controllers/log.manager";
import { QueueManager } from "../controllers/queue.manager";
import { _getString } from "../common/apperror";
import { getRandomDelaySeconds } from "../common/utils";
import { QUEUE_COPY_CONTROL, QUEUE_COPY_JOBS } from "../common/constants";


export async function bckStartSnapshotCopyJob(queueItem: SnapshotCopy, context: InvocationContext): Promise<void> {

    const logger = new AzureLogger(context);

    try {
        const logManager = new BackupLogManager(logger);

        // A. Start snapshot copy to secondary region
        const snapshotManager = new SnapshotManager(logger, queueItem.primarySnapshot.subscriptionId);

        const secondarySnapshot = await snapshotManager.startCopySnapshotToAnotherRegion(queueItem.sourceDiskId, queueItem.primarySnapshot, queueItem.secondaryLocation, queueItem.vmRecoveryInfo);

        const msgStartCopy = `Started snapshot copy ${queueItem.primarySnapshot.id} to location ${queueItem.secondaryLocation}`;
        logger.info(msgStartCopy);

        const logEntryStartCopy: BackupJobLogEntry = {
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
        const retryAfter = process.env.SMCP_BCK_RETRY_CONTROL_COPY_MINUTES ? parseInt(process.env.SMCP_BCK_RETRY_CONTROL_COPY_MINUTES) * 60 : 60*60; // 1 hour in seconds
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

        const queueManager = new QueueManager(logger, process.env.AzureWebJobsStorage__accountname || "", QUEUE_COPY_CONTROL);
        await queueManager.sendMessage(JSON.stringify(snapshotControl), retryAfter);
    } catch (err) {
        const errMsg = _getString(err);

        // Detect subscription CopyStart limit error (service message)
        const isCopyLimitError = /CopyStart requests limit|ongoing CopyStart|number of ongoing CopyStart/i.test(errMsg);

        if (isCopyLimitError) {
            // attempt counter kept inside payload
            const attempt = ((queueItem as any).attempt ?? 0) + 1;
            (queueItem as any).attempt = attempt;

            /*
            if (attempt > 20) {
                // Max attempts reached
                const maxRetryMsg = `Exceeded max retry attempts (20) for copy ${queueItem.primarySnapshot.id}. Recording failure and not requeuing.`;
                logger.error(maxRetryMsg);

                // End process
                const logEntryError: BackupJobLogEntry = {
                    jobId: queueItem.jobId,
                    jobOperation: 'Error',
                    jobStatus: 'Snapshot Failed',
                    jobType: 'Snapshot',
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
            logger.warn(`CopyStart limit reached. Re-scheduling copy ${queueItem.primarySnapshot.id} (attempt ${attempt})`);

            const qm = new QueueManager(logger, process.env.AzureWebJobsStorage__accountname || "", QUEUE_COPY_JOBS);

            // requeue the control copy message with delay (exponential backoff)
            // set visibility/time to retry later (e.g., 60s or exponential based on attempt count)
            // former value: 8-20 minutes
            const randomDelay = getRandomDelaySeconds(6, 12); 
            await qm.sendMessage(JSON.stringify(queueItem), randomDelay); // Delay in seconds

        } else {
            // Other error - just fail and log
            logger.error(`Failed starting copy for ${queueItem.primarySnapshot}: ${errMsg}`);

            // End process
            const msgError = `Disk snapshot copy with job ID ${queueItem.jobId} for disk ID ${queueItem.sourceDiskId} failed with error ${_getString(err)}`;
            const logEntryError: BackupJobLogEntry = {
                jobId: queueItem.jobId,
                jobOperation: 'Error',
                jobStatus: 'Snapshot Failed',
                jobType: 'Snapshot',
                message: msgError,
                sourceVmId: queueItem.sourceVmId,
                sourceDiskId: queueItem.sourceDiskId
            }
            const logManager = new BackupLogManager(logger);
            await logManager.uploadLog(logEntryError);

            // This rethrown exception will only fail the individual invocation, instead of crashing the whole process
            throw err;
        }
    }
            
}

app.storageQueue('bckStartSnapshotCopyJob', {
    queueName: QUEUE_COPY_JOBS,
    connection: 'AzureWebJobsStorage',
    handler: bckStartSnapshotCopyJob
});
