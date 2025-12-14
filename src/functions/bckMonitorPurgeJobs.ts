import { app, InvocationContext, Timer } from "@azure/functions";

import { AzureLogger, ILogger } from '../common/logger';
import { _getString } from "../common/apperror";
import { DefaultAzureCredential } from "@azure/identity";
import { ManagementLockClient, ManagementLockObject } from "@azure/arm-locks";
import { LogsQueryClient, LogsQueryResultStatus } from "@azure/monitor-query-logs";


interface PurgeJobStatus {
    completedCount: number;
    inProgressCount: number;
    failedCount: number;
    subscriptionId: string;
}


async function createDeleteLock(
    logger: ILogger,
    subscriptionId: string,
    resourceGroup: string
): Promise<void> {
    try {
        const credential = new DefaultAzureCredential();
        const lockClient = new ManagementLockClient(credential, subscriptionId);
        
        const lockName = `purge-complete-lock`;
        const lockLevel = "CanNotDelete";
        
        const lockParameters: ManagementLockObject = {
            level: lockLevel,
            notes: `Delete lock created automatically after all purge jobs completed on ${new Date().toISOString()}`
        };

        logger.info(`Creating delete lock '${lockName}' on resource group '${resourceGroup}'`);
        
        await lockClient.managementLocks.createOrUpdateAtResourceGroupLevel(
            resourceGroup,
            lockName,
            lockParameters
        );
        
        logger.info(`Successfully created delete lock on resource group '${resourceGroup}'`);
    } catch (error) {
        logger.error(`Failed to create delete lock on resource group '${resourceGroup}': ${_getString(error)}`);
        throw error;
    }
}


export async function bckMonitorPurgeJobs(myTimer: Timer, context: InvocationContext): Promise<void> {

    const logger = new AzureLogger(context);
    logger.info('Timer function bckMonitorPurgeJobs checking purge job status.');

    try {
        // Get Log Analytics workspace ID from environment
        const workspaceId = process.env.SMCP_BCK_LOG_ANALYTICS_WORKSPACE_ID;
        if (!workspaceId) {
            logger.error('SMCP_BCK_LOG_ANALYTICS_WORKSPACE_ID environment variable not set');
            return;
        }

        // Get target resource group for snapshots from environment
        const targetResourceGroup = process.env.SMCP_BCK_TARGET_RESOURCE_GROUP;
        if (!targetResourceGroup) {
            logger.error('SMCP_BCK_TARGET_RESOURCE_GROUP environment variable not set');
            return;
        }

        const credential = new DefaultAzureCredential();
        const logsQueryClient = new LogsQueryClient(credential);
        
        // Query the logs table for all purge jobs
        const query = `
            SnapshotsOperations_CL
            | where jobType == "Purge"
            | extend subscriptionId = extract(@"/subscriptions/([^/]+)", 1, tolower(sourceVmId))
            | where TimeGenerated >= ago(1d)
            | summarize Operations = make_set(jobStatus) by jobId, subscriptionId
            | extend 
                IsCompleted = Operations has "Purge Completed",
                IsInProgress = Operations has "Purge In Progress" and not(Operations has "Purge Completed") and not(Operations has "Purge Failed"),
                IsFailed = Operations has "Purge Failed" and not(Operations has "Purge Completed")
            | summarize 
                CompletedJobs = countif(IsCompleted),
                InProgressJobs = countif(IsInProgress),
                FailedJobs = countif(IsFailed)
                by subscriptionId
        `;

        logger.info('Querying Log Analytics for purge job status...');
        const result = await logsQueryClient.queryWorkspace(workspaceId, query, { duration: "P1D" });

        if (result.status !== LogsQueryResultStatus.Success) {
            logger.error(`Query failed with status: ${result.status}`);
            return;
        }

        if (!result.tables || result.tables.length === 0 || !result.tables[0].rows.length) {
            logger.info('No purge jobs found in the last day');
            return;
        }

        const jobs: PurgeJobStatus[] = result.tables[0].rows.map((row: any) => ({
            subscriptionId: row[0],
            completedCount: row[1],
            inProgressCount: row[2],
            failedCount: row[3]
        }));

        const subscriptionId = jobs[0].subscriptionId; // Assuming all jobs are under the same subscription

        logger.info(`Purge jobs status: ${jobs[0].completedCount} completed, ${jobs[0].inProgressCount} in progress, ${jobs[0].failedCount} with failures`);

        // Create delete locks in the target resource groups if all jobs are complete
        if (jobs[0].inProgressCount == 0) {
            logger.info(`All purge jobs completed. Creating delete lock in resource group ${targetResourceGroup}...`);
            
            try {
                await createDeleteLock(logger, subscriptionId, targetResourceGroup);
            } catch (lockError) {
                logger.error(`Failed to create lock for resource group '${targetResourceGroup}': ${_getString(lockError)}`);
                // Continue processing other resource groups
            }
        }

        logger.info('Purge job monitoring completed.');

    } catch (err) {
        logger.error(`Failed to monitor purge jobs: ${_getString(err)}`);
        // This rethrown exception will only fail the individual invocation, instead of crashing the whole process
        throw err;
    }
}

app.timer('bckMonitorPurgeJobs', {
    schedule: '0 25 8,11,14,17,20,23,2 * * *', // Every 3 hours starting at 8:25 (8:25, 11:25, 14:25, 17:25, 20:25, 23:25, 2:25)
    handler: bckMonitorPurgeJobs
});
