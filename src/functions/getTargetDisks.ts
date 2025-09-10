import { app, InvocationContext, Timer, output } from "@azure/functions";

import { AzureLogger } from "../common/logger";
import { ResourceGraphManager } from "../controllers/graph.manager";


const snapshotsQueueOutput = output.storageQueue({
    queueName: 'snapshot-jobs',
    connection: 'AzureWebJobsStorage'
});


export async function getTargetDisks(myTimer: Timer, context: InvocationContext): Promise<void> {

    const logger = new AzureLogger(context);
    logger.info('Timer function getTargetDisks trigger request.');

    try {
        // Get disks to be backed up
        const graphManager = new ResourceGraphManager(logger);
        const disksToBackup = await graphManager.getDisksToBackup();

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

app.timer('getTargetDisks', {
    schedule: '0 30 6 * * *', // every day at 06:30 in the morning
    extraOutputs: [
        snapshotsQueueOutput
    ],
    handler: getTargetDisks
});
