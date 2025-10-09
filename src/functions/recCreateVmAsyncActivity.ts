import * as df from 'durable-functions';
import { ActivityHandler } from 'durable-functions';
import { InvocationContext } from '@azure/functions';
import { AzureLogger } from '../common/logger';
import { CREATE_VM_ASYNC_ACTIVITY, QUEUE_CONTROL_VM_CREATION } from '../common/constants';
import { RecoveryJobLogEntry, NewVmDetails, VmCreationResult, VmDisk } from '../common/interfaces';
import { VmManager } from '../controllers/vm.manager';
import { QueueManager } from "../controllers/queue.manager";
import { extractSubscriptionIdFromResourceId, generateGuid } from '../common/utils';
import { _getString } from '../common/apperror';
import { RecoveryLogManager } from "../controllers/log.manager";
import { PermanentError, TransientError, BusinessError, classifyError } from '../common/errors';


const recCreateVmAsyncActivity: ActivityHandler = async (input: NewVmDetails, context: InvocationContext): Promise<VmCreationResult> => {

    const logger = new AzureLogger(context);
    logger.info('Activity function recCreateVmAsyncActivity trigger request.');

    // Create Job Id (correlation Id) for operation
    const jobId = generateGuid();

    try {
        // Input validation (permanent errors)
        if (!input) {
            throw new PermanentError('Input is required');
        }
        if (!input.sourceSnapshot) {
            throw new PermanentError('sourceSnapshot is required');
        }
        if (!input.targetSubnetId) {
            throw new PermanentError('targetSubnetId is required');
        }
        if (!input.targetResourceGroup) {
            throw new PermanentError('targetResourceGroup is required');
        }

        // Business logic validation
        if (input.sourceSnapshot.diskProfile !== 'os-disk') {
            throw new BusinessError(`Cannot create VM from ${input.sourceSnapshot.diskProfile} snapshot. Only os-disk snapshots are supported.`);
        }

        // Log start
        const msgStart = `Starting async VM creation for ${input.sourceSnapshot.vmName} from ${input.sourceSnapshot.id}`;
        const logEntryStart: RecoveryJobLogEntry = {
            jobId: jobId,
            jobOperation: 'VM Create Start',
            jobStatus: 'Restore In Progress',
            jobType: 'Restore',
            message: msgStart,
            vmName: input.sourceSnapshot.vmName,
            vmSize: input.sourceSnapshot.vmSize,
            diskProfile: input.sourceSnapshot.diskProfile,
            diskSku: input.sourceSnapshot.diskSku,
            snapshotId: input.sourceSnapshot.id,
            snapshotName: input.sourceSnapshot.snapshotName,
            batchId: input.batchId
        };
        const logManager = new RecoveryLogManager(logger);
        await logManager.uploadLog(logEntryStart);

        // Create disk from snapshot (can have transient failures)
        const subscriptionId = extractSubscriptionIdFromResourceId(input.sourceSnapshot.id);
        const vmManager = new VmManager(logger, subscriptionId);
        
        let osDisk: VmDisk;
        try {
            osDisk = await vmManager.createDiskFromSnapshot(input, jobId);
            logger.info(`✅ Successfully created new disk: ${osDisk.id}`);
        } catch (error) {
            const classifiedError = classifyVmManagerError(error, 'disk creation');
            throw classifiedError;
        }
        
        // Start VM creation (async with queue polling)
        let vmCreationResult: VmCreationResult;
        try {

            vmCreationResult = await vmManager.createVirtualMachineAsync(input, osDisk, jobId);
            
            if (vmCreationResult.success && vmCreationResult.pollerMessage) {
                // VM creation started successfully, send to polling queue
                logger.info(`✅ VM creation started for: ${input.sourceSnapshot.vmName}, sending to polling queue`);
                
                const queueManager = new QueueManager(logger, process.env.AzureWebJobsStorage__accountname || "", QUEUE_CONTROL_VM_CREATION);
                const baseDelay = parseInt(process.env.SMCP_REC_VM_POLL_DELAY_SECONDS || '60'); // 1 minute base delay
                await queueManager.sendMessage(JSON.stringify(vmCreationResult.pollerMessage), baseDelay);
                
                // Log polling initiated
                const msgPolling = `VM creation polling initiated for ${input.sourceSnapshot.vmName}, operation ID: ${vmCreationResult.pollerMessage.operationId}`;
                const logEntryPolling: RecoveryJobLogEntry = {
                    ...logEntryStart,
                    jobOperation: 'VM Create Polling',
                    jobStatus: 'Restore In Progress',
                    message: msgPolling
                };
                await logManager.uploadLog(logEntryPolling);
                
                return vmCreationResult;
                
            } else {
                // VM creation failed
                throw new Error(vmCreationResult.error || 'VM creation failed with unknown error');
            }
            
        } catch (error) {
            const classifiedError = classifyVmManagerError(error, 'VM creation');
            throw classifiedError;
        }
        
    } catch (error) {
        // Classify the error if it hasn't been classified yet
        const classifiedError = classifyError(error);
        
        const msgFailActivity = `❌ Failed to start VM creation from snapshot ${input.sourceSnapshot?.id}: ${_getString(classifiedError)}`;
        logger.error(msgFailActivity, {
            errorType: classifiedError.constructor.name,
            isRetriable: classifiedError instanceof TransientError,
            originalError: error.message
        });

        // Activity failed
        const logEntryFailed: RecoveryJobLogEntry = {
            jobId: jobId,
            jobOperation: 'Error',
            jobStatus: 'Restore Failed',
            jobType: 'Restore',
            message: msgFailActivity,
            vmName: input.sourceSnapshot?.vmName,
            vmSize: input.sourceSnapshot?.vmSize,
            diskProfile: input.sourceSnapshot?.diskProfile,
            diskSku: input.sourceSnapshot?.diskSku,
            snapshotId: input.sourceSnapshot?.id,
            snapshotName: input.sourceSnapshot?.snapshotName,
            batchId: input.batchId
        };
        const logManager = new RecoveryLogManager(logger);
        try {
            await logManager.uploadLog(logEntryFailed);
        } catch (logError) {
            logger.error('Failed to log error entry:', logError);
        }

        // Return error result instead of throwing to allow batch processing to continue
        return {
            success: false,
            error: classifiedError.message
        };
    }
};

/**
 * Classify errors from VM Manager operations
 */
function classifyVmManagerError(error: any, operation: string): Error {
    const message = error.message || error.toString();
    
    // Azure quota exceeded
    if (message.includes('quota') || message.includes('limit')) {
        return new TransientError(`${operation} failed due to quota limits: ${message}`, error);
    }
    
    // Resource already exists
    if (message.includes('already exists') || message.includes('ConflictError')) {
        return new PermanentError(`${operation} failed - resource already exists: ${message}`, error);
    }
    
    // Authentication/authorization
    if (message.includes('Unauthorized') || message.includes('Forbidden')) {
        return new PermanentError(`${operation} failed - authentication/authorization error: ${message}`, error);
    }
    
    // Network/connectivity issues
    if (message.includes('timeout') || message.includes('network') || message.includes('connection')) {
        return new TransientError(`${operation} failed due to network issues: ${message}`, error);
    }
    
    // Rate limiting
    if (message.includes('throttle') || message.includes('rate limit')) {
        return new TransientError(`${operation} failed due to rate limiting: ${message}`, error);
    }
    
    // Resource not found
    if (message.includes('NotFound') || message.includes('does not exist')) {
        return new PermanentError(`${operation} failed - resource not found: ${message}`, error);
    }
    
    // Default classification
    return classifyError(error);
}

df.app.activity(CREATE_VM_ASYNC_ACTIVITY, { handler: recCreateVmAsyncActivity });

export { CREATE_VM_ASYNC_ACTIVITY };
export default recCreateVmAsyncActivity;