import { app, InvocationContext, Timer, output } from "@azure/functions";

import { AzureLogger } from "../common/logger";
import { ResourceGraphManager } from "../controllers/graph.manager";
import { QUEUE_SNAPSHOT_JOBS } from "../common/constants";


const snapshotsQueueOutput = output.storageQueue({
    queueName: QUEUE_SNAPSHOT_JOBS,
    connection: 'AzureWebJobsStorage'
});


export async function bckGetDisksToSnapshot(myTimer: Timer, context: InvocationContext): Promise<void> {

    const logger = new AzureLogger(context);
    logger.info('Timer function bckGetDisksToSnapshot trigger request.');

    try {
        // Get trigger tag from environment variable
        const triggerTag = process.env['SMCP_BCK_BACKUP_TRIGGER_TAG'] ? JSON.parse(process.env['SMCP_BCK_BACKUP_TRIGGER_TAG']) : { key: 'smcp-backup', value: 'on' };

        // Get disks to be backed up
        const graphManager = new ResourceGraphManager(logger);
        const disksToBackup = await graphManager.getDisksToBackup(triggerTag.key, triggerTag.value);
        logger.info(`Disks to backup: ${disksToBackup.length} available.`);

        if (disksToBackup.length > 0) {
            // Trigger notifications using Storage Queue: to start a new job for source disk backup with snapshots
            context.extraOutputs.set(snapshotsQueueOutput, disksToBackup);
        }

    } catch (err) {
        logger.error(err);
        // This rethrown exception will only fail the individual invocation, instead of crashing the whole process
        throw err;
    }
}

app.timer('bckGetDisksToSnapshot', {
    schedule: '0 30 1 * * *', // every day at 01:30 in the morning
    extraOutputs: [
        snapshotsQueueOutput
    ],
    handler: bckGetDisksToSnapshot
});
