import { app, InvocationContext } from '@azure/functions';
import { AzureLogger } from '../common/logger';
import { RecoveryJobLogEntry, VmCreationPollMessage, VmCreationResult } from '../common/interfaces';
import { VmManager } from '../controllers/vm.manager';
import { QueueManager } from '../controllers/queue.manager';
import { extractSubscriptionIdFromResourceId } from '../common/utils';
import { PermanentError, TransientError, classifyError } from '../common/errors';
import { QUEUE_CONTROL_VM_CREATION } from '../common/constants';
import { RecoveryLogManager } from '../controllers/log.manager';

export async function recControlVmCreation(queueItem: unknown, context: InvocationContext): Promise<void> {
    const logger = new AzureLogger(context);
    logger.info('🔍 VM Creation Poller function triggered');

    try {
        // Decode and parse the queue message
        let pollMessage: VmCreationPollMessage;
        try {
            // Handle Base64 encoded messages
            let messageText: string;
            if (typeof queueItem === 'string') {
                try {
                    // Try to decode from Base64
                    messageText = Buffer.from(queueItem, 'base64').toString('utf-8');
                } catch {
                    // If Base64 decode fails, treat as plain text
                    messageText = queueItem;
                }
            } else {
                messageText = JSON.stringify(queueItem);
            }

            pollMessage = JSON.parse(messageText);
        } catch (error) {
            logger.error('Failed to parse queue message:', error);
            throw new PermanentError('Invalid queue message format');
        }

        // Validate message structure
        if (!pollMessage.vmName || !pollMessage.targetResourceGroup || !pollMessage.operationId) {
            throw new PermanentError('Missing required fields in poll message');
        }

        logger.info(`Checking VM creation status for: ${pollMessage.vmName}, attempt: ${(pollMessage.retryCount || 0) + 1}`);

        // Extract subscription ID and create VM manager
        const subscriptionId = extractSubscriptionIdFromResourceId(pollMessage.sourceSnapshot.id);
        const vmManager = new VmManager(logger, subscriptionId);

        // Check VM creation status
        const result: VmCreationResult = await vmManager.checkVmCreationStatus(pollMessage);

        // Get environment variables for queue management
        const queueManager = new QueueManager(logger, process.env.AzureWebJobsStorage__accountname || "", QUEUE_CONTROL_VM_CREATION);

        if (result.success && result.vmInfo) {
            // VM creation completed successfully
            logger.info(`✅ VM creation completed successfully: ${result.vmInfo.name} with IP: ${result.vmInfo.ipAddress}`);
            
            // Log completion
            const msgEnd = `Finished the creation of VM ${pollMessage.sourceSnapshot.vmName} from ${pollMessage.sourceSnapshot.id}`
            const logEntryEnd: RecoveryJobLogEntry = {
                batchId: pollMessage.batchId,
                jobId: pollMessage.jobId,
                jobOperation: 'VM Create End',
                jobStatus: 'Restore Completed',
                jobType: 'Restore',
                message: msgEnd,
                vmName: pollMessage.sourceSnapshot.vmName,
                vmSize: pollMessage.sourceSnapshot.vmSize,
                diskProfile: pollMessage.sourceSnapshot.diskProfile,
                diskSku: pollMessage.sourceSnapshot.diskSku,
                snapshotId: pollMessage.sourceSnapshot.id,
                snapshotName: pollMessage.sourceSnapshot.snapshotName,
                vmId: result.vmInfo.id,
                ipAddress: result.vmInfo.ipAddress
            }
            const logManager = new RecoveryLogManager(logger);
            await logManager.uploadLog(logEntryEnd);

        } else if (result.pollerMessage) {
            // VM creation still in progress, schedule retry
            const retryCount = result.pollerMessage.retryCount || 0;
            const maxRetries = parseInt(process.env.SMCP_REC_VM_POLL_MAX_RETRIES || '30'); // 30 attempts = ~30 minutes with 1-minute intervals
            
            if (retryCount < maxRetries) {
                logger.info(`🔄 VM creation still in progress for: ${pollMessage.vmName}, scheduling retry ${retryCount + 1}/${maxRetries}`);
                
                // Calculate delay - exponential backoff with max delay
                const baseDelay = parseInt(process.env.SMCP_REC_VM_POLL_DELAY_SECONDS || '60'); // 1 minute base delay
                const maxDelay = parseInt(process.env.SMCP_REC_VM_POLL_MAX_DELAY_SECONDS || '600'); // 10 minutes max delay
                const delay = Math.min(baseDelay * Math.pow(1.5, Math.min(retryCount, 5)), maxDelay);
                
                // Schedule retry with delay
                await queueManager.scheduleVmPollRetry(result.pollerMessage!, delay);
                logger.info(`Scheduled retry for ${pollMessage.vmName} in ${delay} seconds`);
                
            } else {
                // Max retries reached, mark as failed
                const msgCreationFail = `❌ VM creation polling max retries (${maxRetries}) reached for: ${pollMessage.vmName}`;
                logger.error(msgCreationFail);
 
                // Log
                const logEntryFailed: RecoveryJobLogEntry = {
                    batchId: pollMessage.batchId,
                    jobId: pollMessage.jobId,
                    jobOperation: 'Error',
                    jobStatus: 'Restore Failed',
                    jobType: 'Restore',
                    message: msgCreationFail,
                    vmName: pollMessage.sourceSnapshot?.vmName,
                    vmSize: pollMessage.sourceSnapshot?.vmSize,
                    diskProfile: pollMessage.sourceSnapshot?.diskProfile,
                    diskSku: pollMessage.sourceSnapshot?.diskSku,
                    snapshotId: pollMessage.sourceSnapshot?.id,
                    snapshotName: pollMessage.sourceSnapshot?.snapshotName
                };
                const logManager = new RecoveryLogManager(logger);
                await logManager.uploadLog(logEntryFailed);
            }
            
        } else {
            // VM creation failed permanently
            const msgCreationFail = `❌ VM creation failed permanently for: ${pollMessage.vmName}, error: ${result.error}`;
            logger.error(msgCreationFail);

            // Log failed
            const logEntryFailed: RecoveryJobLogEntry = {
                batchId: pollMessage.batchId,
                jobId: pollMessage.jobId,
                jobOperation: 'Error',
                jobStatus: 'Restore Failed',
                jobType: 'Restore',
                message: msgCreationFail,
                vmName: pollMessage.sourceSnapshot?.vmName,
                vmSize: pollMessage.sourceSnapshot?.vmSize,
                diskProfile: pollMessage.sourceSnapshot?.diskProfile,
                diskSku: pollMessage.sourceSnapshot?.diskSku,
                snapshotId: pollMessage.sourceSnapshot?.id,
                snapshotName: pollMessage.sourceSnapshot?.snapshotName
            };
            const logManager = new RecoveryLogManager(logger);
            await logManager.uploadLog(logEntryFailed);
        }

    } catch (error) {
        const classifiedError = classifyError(error);
        logger.error('VM Creation Poller failed:', {
            errorType: classifiedError.constructor.name,
            message: classifiedError.message,
            isRetryable: !(classifiedError instanceof PermanentError)
        });
        
        // For permanent errors, we don't want to retry the queue message
        if (classifiedError instanceof PermanentError) {
            logger.error('Permanent error in VM poller - message will be discarded');
        } else {
            // For transient errors, let the queue handle retry
            throw classifiedError;
        }
    }
}

// Register the function
app.storageQueue('recControlVmCreation', {
    queueName: QUEUE_CONTROL_VM_CREATION,
    connection: 'AzureWebJobsStorage',
    handler: recControlVmCreation
});

export default recControlVmCreation;