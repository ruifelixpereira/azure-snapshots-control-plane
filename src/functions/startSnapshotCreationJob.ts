import { app, InvocationContext } from "@azure/functions";

import { AzureLogger } from '../common/logger';
import { SnapshotSource, SnapshotCopyControl, JobLogEntry } from "../common/interfaces";
import { generateGuid } from "../common/utils";
import { SnapshotManager } from "../controllers/snapshot.manager";
import { LogManager } from "../controllers/log.manager";
import { QueueManager } from "../controllers/queue.manager";
import { _getString } from "../common/apperror";


export async function startSnapshotCreationJob(queueItem: SnapshotSource, context: InvocationContext): Promise<void> {

    const logger = new AzureLogger(context);

    // Create Job Id (correlation Id) for operation
    const jobId = generateGuid();

    try {
        const logManager = new LogManager(logger);
        
        // Start process
        const msgStartProcess = `Starting the snapshot job ID ${jobId} for disk ID ${queueItem.diskId}`
        logger.info(msgStartProcess);
        const logEntryStartProcess: JobLogEntry = {
            jobId: jobId,
            jobOperation: 'Start',
            jobStatus: 'Snapshot In Progress',
            jobType: 'Snapshot',
            message: msgStartProcess,
            sourceVmId: queueItem.vmId,
            sourceDiskId: queueItem.diskId
        }
        await logManager.uploadLog(logEntryStartProcess);

        // A. Create incremental disk snapshot
        const snapshotManager = new SnapshotManager(logger, queueItem.subscriptionId);
        const primarySnapshot = await snapshotManager.createIncrementalSnapshot(queueItem);
        const msgSnapshotCreated = `Created snapshot ${primarySnapshot.id} for disk ID ${queueItem.diskId}`;
        logger.info(msgSnapshotCreated);

        const logEntrySnapshotCreated: JobLogEntry = { 
            ...logEntryStartProcess,
            jobOperation: 'Snapshot Create',
            message: msgSnapshotCreated,
            primarySnapshotId: primarySnapshot.id,
            primaryLocation: primarySnapshot.location
        }
        await logManager.uploadLog(logEntrySnapshotCreated);

        // B. Start snapshot copy to secondary region
        const secondarySnapshot = await snapshotManager.startCopySnapshotToAnotherRegion(primarySnapshot, process.env.SNAPSHOT_SECONDARY_LOCATION);
        const msgStartCopy = `Started snapshot copy ${primarySnapshot.id} to location ${process.env.SNAPSHOT_SECONDARY_LOCATION}`;
        logger.info(msgSnapshotCreated);

        const logEntryStartCopy: JobLogEntry = {
            ...logEntrySnapshotCreated,
            jobOperation: 'Snapshot Copy Start',
            message: msgStartCopy,
            secondarySnapshotId: secondarySnapshot.id,
            secondaryLocation: secondarySnapshot.location
        }
        await logManager.uploadLog(logEntryStartCopy);

        // C. Send control copy event with a visibility timeout of 1 hour
        const retryAfter = process.env.SNAPSHOT_RETRY_CONTROL_COPY_MINUTES ? parseInt(process.env.SNAPSHOT_RETRY_CONTROL_COPY_MINUTES) * 60 : 60*60; // 1 hour in seconds
        logger.info(`Sending control copy event for disk ID ${queueItem.diskId} and snapshot ID ${primarySnapshot.id} with retry after ${retryAfter} seconds`);

        const snapshotControl: SnapshotCopyControl = {
            control: {
                jobId: jobId,
                sourceVmId: queueItem.vmId,
                sourceDiskId: queueItem.diskId,
                primarySnapshotId: primarySnapshot.id,
                secondarySnapshotId: secondarySnapshot.id,
                primaryLocation: primarySnapshot.location,
                secondaryLocation: secondarySnapshot.location
            },
            snapshot: secondarySnapshot
        };

        const queueManager = new QueueManager(logger, process.env.AzureWebJobsStorage || "", 'copy-control');
        await queueManager.sendMessage(JSON.stringify(snapshotControl), retryAfter);
        
    } catch (err) {
        logger.error(err);

        // End process
        const msgError = `Disk snapshot job ID ${jobId} for disk ID ${queueItem.diskId} failed with error ${_getString(err)}`;
        const logEntryError: JobLogEntry = {
            jobId: jobId,
            jobOperation: 'Error',
            jobStatus: 'Snapshot Failed',
            jobType: 'Snapshot',
            message: msgError,
            sourceVmId: queueItem.vmId,
            sourceDiskId: queueItem.diskId
        }
        const logManager = new LogManager(logger);
        await logManager.uploadLog(logEntryError);

        // This rethrown exception will only fail the individual invocation, instead of crashing the whole process
        throw err;
    }
}

app.storageQueue('startSnapshotCreationJob', {
    queueName: 'snapshot-jobs',
    connection: 'AzureWebJobsStorage',
    handler: startSnapshotCreationJob
});
