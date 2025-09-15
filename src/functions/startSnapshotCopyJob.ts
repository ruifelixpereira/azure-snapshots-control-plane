import { app, InvocationContext } from "@azure/functions";

import { AzureLogger } from '../common/logger';
import { SnapshotCopy, SnapshotCopyControl, JobLogEntry } from "../common/interfaces";
import { SnapshotManager } from "../controllers/snapshot.manager";
import { LogManager } from "../controllers/log.manager";
import { QueueManager } from "../controllers/queue.manager";
import { AtomicCounterRedis } from "../controllers/atomicCounterRedis";
import { _getString } from "../common/apperror";


export async function startSnapshotCopyJob(queueItem: SnapshotCopy, context: InvocationContext): Promise<void> {

    const logger = new AzureLogger(context);

    try {
        const logManager = new LogManager(logger);

        const redisUrl = process.env.REDIS_ENDPOINT || "xpto.redis.cache.windows.net:6380";
        const atomicCounter = new AtomicCounterRedis(redisUrl);

        const got = await atomicCounter.tryAcquire(100); // limit to 100 concurrent copies

        const testVal = await atomicCounter.count();
        logger.info(`Released one slot in Redis counter. Current count is ${testVal}`);

        if (!got) {
            logger.warn(`Copy concurrency limit reached. Re-scheduling copy for ${queueItem.primarySnapshot.id}`);
            const qm = new QueueManager(logger, process.env.AzureWebJobsStorage__accountname || "", 'copy-jobs');
            // requeue the control copy message with delay (exponential backoff)
            // set visibility/time to retry later (e.g., 60s or exponential based on attempt count)

            // Returns a random integer from 4 to 12:
            const randomDelay = Math.floor(Math.random() * 8) + 4;
            await qm.sendMessage(JSON.stringify(queueItem), randomDelay * 60); // Delay in seconds
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
                try {
                    await atomicCounter.release();
                } catch (releaseErr) {
                    logger.warn(`Failed to release redis counter after failed start for ${queueItem.primarySnapshot.id}: ${_getString(releaseErr)}`);
                }

                const errMsg = _getString(err);
                logger.error(`Failed starting copy for ${queueItem.primarySnapshot.id}: ${errMsg}`);

                // Detect subscription CopyStart limit error (service message)
                const isCopyLimitError = /CopyStart requests limit|ongoing CopyStart|number of ongoing CopyStart/i.test(errMsg);

                if (isCopyLimitError) {
                    // Exponential backoff configuration (tunable via env)
                    const maxAttempts = parseInt(process.env.SNAPSHOT_RETRY_MAX_ATTEMPTS || '10', 10);
                    const baseSeconds = parseInt(process.env.SNAPSHOT_RETRY_BASE_SECONDS || '60', 10); // default 60s
                    const maxMinutes = parseInt(process.env.SNAPSHOT_RETRY_MAX_MINUTES || '60', 10);
                    const maxSeconds = maxMinutes * 60;

                    // attempt counter kept inside payload
                    const attempt = ((queueItem as any).attempt ?? 0) + 1;
                    (queueItem as any).attempt = attempt;

                    if (attempt > maxAttempts) {
                        logger.error(`Exceeded max retry attempts (${maxAttempts}) for copy ${queueItem.primarySnapshot.id}. Recording failure and not requeuing.`);
                        throw err;
                    }

                    // exponential backoff: base * 2^(attempt-1)
                    const expDelay = Math.min(maxSeconds, Math.floor(baseSeconds * Math.pow(2, attempt - 1)));
                    // jitter to avoid thundering herd
                    const jitter = Math.floor(Math.random() * Math.max(1, baseSeconds));
                    const delaySeconds = expDelay + jitter;

                    logger.warn(`CopyStart limit reached. Re-scheduling copy ${queueItem.primarySnapshot.id} (attempt ${attempt}) in ${delaySeconds}s`);

                    const qm = new QueueManager(logger, process.env.AzureWebJobsStorage__accountname || "", 'copy-jobs');
                    await qm.sendMessage(JSON.stringify(queueItem), delaySeconds);
                } else {
                    // Other error - just fail and log
                    throw err;
                }
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
