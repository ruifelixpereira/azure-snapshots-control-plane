import { app, InvocationContext, output } from "@azure/functions";

import { AzureLogger } from '../common/logger';
import { SnapshotSource, SnapshotCopyControl, SnapshotPurgeSource, JobLogEntry } from "../common/interfaces";
import { generateGuid } from "../common/utils";
import { SnapshotManager } from "../controllers/snapshot.manager";
import { LogManager } from "../controllers/log.manager";
import { QueueManager } from "../controllers/queue.manager";
import { _getString } from "../common/apperror";

const purgeJobsQueueOutput = output.storageQueue({
    queueName: 'purge-jobs',
    connection: 'AzureWebJobsStorage'
});

const bulkPurgeJobsQueueOutput = output.storageQueue({
    queueName: 'bulk-purge-jobs',
    connection: 'AzureWebJobsStorage'
});

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

        // A. Create incremental disk snapshot in primary region
        const snapshotManager = new SnapshotManager(logger, queueItem.subscriptionId);
        const primarySnapshot = await snapshotManager.createIncrementalSnapshot(queueItem);
        const msgSnapshotCreated = `Created snapshot ${primarySnapshot.id} for disk ID ${queueItem.diskId}`;
        logger.info(msgSnapshotCreated);

        // B. Ingest telemetry
        const logEntrySnapshotCreated: JobLogEntry = { 
            ...logEntryStartProcess,
            jobOperation: 'Snapshot Create',
            message: msgSnapshotCreated,
            primarySnapshotId: primarySnapshot.id,
            primaryLocation: primarySnapshot.location
        }
        await logManager.uploadLog(logEntrySnapshotCreated);

        // Check if we only want snapshots in the primary region 
        // and we don't need to copy it to the secondary region
        const secondaryNumberOfDays = process.env.SNAPSHOT_PURGE_SECONDARY_LOCATION_NUMBER_OF_DAYS ? parseInt(process.env.SNAPSHOT_PURGE_SECONDARY_LOCATION_NUMBER_OF_DAYS) : 10;

        if (secondaryNumberOfDays <= 0) {

            // No copy is needed in the secondary region so the snapshot backup process is completed
            const logEntryCompleted: JobLogEntry = {
                ...logEntrySnapshotCreated,
                jobOperation: 'Snapshot Create End',
                jobStatus: 'Snapshot Completed',
                message: `Snapshot creation finished and no copy is required for secondary region`,
            }
            await logManager.uploadLog(logEntryCompleted);

            // C. Trigger old snapshots purge in primary and secondary locations
            logger.info(`Sending trigger message to start purge event for disk ID ${queueItem.diskId} and primary location ${primarySnapshot.location}`);

            const purgePrimary: SnapshotPurgeSource = {
                control: {
                    jobId: jobId,
                    sourceVmId: queueItem.vmId,
                    sourceDiskId: queueItem.diskId,
                    primarySnapshotId: primarySnapshot.id,
                    secondarySnapshotId: "na",
                    primaryLocation: primarySnapshot.location,
                    secondaryLocation: "na"
                },
                type: 'primary'
            };

            // Send notifications using Storage Queue
            context.extraOutputs.set(purgeJobsQueueOutput, purgePrimary);

            // D. Trigger all snapshots purge in secondary location
            const snapshotBulkPurgeActive = process.env.SNAPSHOT_BULK_PURGE_ACTIVE ? process.env.SNAPSHOT_BULK_PURGE_ACTIVE.toLowerCase() === 'true' : false;
            if (snapshotBulkPurgeActive) {
                logger.info(`Sending trigger message to start purging all snapshots for disk ID ${queueItem.diskId} in the secondary location ${process.env.SNAPSHOT_SECONDARY_LOCATION}`);

                const purgeSecondary: SnapshotPurgeSource = {
                    control: {
                        jobId: jobId,
                        sourceVmId: queueItem.vmId,
                        sourceDiskId: queueItem.diskId,
                        primarySnapshotId: "na",
                        secondarySnapshotId: "all",
                        primaryLocation: "na",
                        secondaryLocation: process.env.SNAPSHOT_SECONDARY_LOCATION
                    },
                    type: 'secondary'
                };

                // Send notifications using Storage Queue
                context.extraOutputs.set(bulkPurgeJobsQueueOutput, purgeSecondary);
            }
            else {
                logger.info(`Bulk purge is not active, skipping sending trigger message to start purging all snapshots for disk ID ${queueItem.diskId} in the secondary location ${process.env.SNAPSHOT_SECONDARY_LOCATION}`);
            }
        }
        else {

            // E. Start snapshot copy to secondary region
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

            // F. Send control copy event with a visibility timeout of 1 hour
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

            const queueManager = new QueueManager(logger, process.env.AzureWebJobsStorage__accountname || "", 'copy-control');
            await queueManager.sendMessage(JSON.stringify(snapshotControl), retryAfter);
        }        
    
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
    extraOutputs: [
        purgeJobsQueueOutput,
        bulkPurgeJobsQueueOutput
    ],
    handler: startSnapshotCreationJob
});
