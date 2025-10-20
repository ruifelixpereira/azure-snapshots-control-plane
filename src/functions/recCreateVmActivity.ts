import * as df from 'durable-functions';
import { ActivityHandler } from 'durable-functions';
import { InvocationContext } from '@azure/functions';
import { CREATE_VM_ACTIVITY } from '../common/constants';
import { AzureLogger } from '../common/logger';
import { RecoveryJobLogEntry, NewVmDetails, VmInfo, VmDisk } from '../common/interfaces';
import { VmManager } from '../controllers/vm.manager';
import { extractSubscriptionIdFromResourceId, generateGuid, generateUniqueString } from '../common/utils';
import { _getString } from '../common/apperror';
import { RecoveryLogManager } from "../controllers/log.manager";
import { PermanentError, TransientError, BusinessError, AzureError, classifyError } from '../common/errors';

const recCreateVmActivity: ActivityHandler = async (input: NewVmDetails, context: InvocationContext): Promise<VmInfo> => {

    const logger = new AzureLogger(context);
    logger.info('Activity function recCreateVmActivity trigger request.');

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

        // Generate unique suffix for VM name if needed
        let uniqueSuffix = "";
        if (input.appendUniqueStringToVmName) {
            uniqueSuffix = `-${generateUniqueString(5)}-`;
        }

        // Log start
        const msgStart = `Starting the creation of VM ${input.sourceSnapshot.vmName} with unique suffix "${uniqueSuffix}" from ${input.sourceSnapshot.id}`
        const logEntryStart: RecoveryJobLogEntry = {
            batchId: input.batchId,
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
            snapshotName: input.sourceSnapshot.snapshotName
        }
        const logManager = new RecoveryLogManager(logger);
        await logManager.uploadLog(logEntryStart);

        // Create disk from snapshot (can have transient failures)
        const subscriptionId = extractSubscriptionIdFromResourceId(input.sourceSnapshot.id);
        const vmManager = new VmManager(logger, subscriptionId);
        
        let osDisk: VmDisk;
        try {
            osDisk = await vmManager.createDiskFromSnapshot(input, jobId, uniqueSuffix);
            logger.info(`✅ Successfully created new disk: ${osDisk.id}`);
        } catch (error) {
            const classifiedError = classifyVmManagerError(error, 'disk creation');
            throw classifiedError;
        }
        
        // Create VM in subnet (can have transient failures)
        let vm: VmInfo;
        try {
            vm = await vmManager.createVirtualMachine(input, osDisk, jobId, uniqueSuffix);
            logger.info(`✅ Successfully created VM: ${vm.name}`);
        } catch (error) {
            const classifiedError = classifyVmManagerError(error, 'VM creation');
            throw classifiedError;
        }

        // Log end
        const msgEnd = `Finished the creation of VM ${input.sourceSnapshot.vmName} from ${input.sourceSnapshot.id}`
        const logEntryEnd: RecoveryJobLogEntry = {
            ...logEntryStart,
            jobOperation: 'VM Create End',
            jobStatus: 'Restore Completed',
            jobType: 'Restore',
            message: msgEnd,
            vmId: vm.id,
            ipAddress: vm.ipAddress
        }
        await logManager.uploadLog(logEntryEnd);

        return vm;
        
    } catch (error) {
        // Classify the error if it hasn't been classified yet
        const classifiedError = classifyError(error);
        
        const msgFailActivity = `❌ Failed to create VM from snapshot ${input.sourceSnapshot?.id}: ${_getString(classifiedError)}`;
        logger.error(msgFailActivity, {
            errorType: classifiedError.constructor.name,
            isRetriable: classifiedError instanceof TransientError,
            originalError: error.message
        });

        // Activity failed
        const logEntryFailed: RecoveryJobLogEntry = {
            batchId: input.batchId,
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
            snapshotName: input.sourceSnapshot?.snapshotName
        }
        const logManager = new RecoveryLogManager(logger);
        try {
            await logManager.uploadLog(logEntryFailed);
        } catch (logError) {
            logger.error('Failed to log error entry:', logError);
        }

        // Re-throw the classified error
        throw classifiedError;
    }

};

/**
 * Classify errors from VM Manager operations
 */
function classifyVmManagerError(error: any, operation: string): Error {
    const message = error.message || error.toString();
    
    // IP address out of range of the subnet address space
    if (message.includes('does not belong to the range of subnet prefix')) {
        return new PermanentError(`${operation} failed - IP address does not belong to the range of subnet prefix: ${message}`, error);
    }

    // Azure quota exceeded
    if (message.includes('quota') || message.includes('limit')) {
        return new TransientError(`${operation} failed due to quota limits: ${message}`, error);
    }
    
    // Resource already exists
    if (message.includes('already exists') || message.includes('ConflictError')) {
        return new PermanentError(`${operation} failed - resource already exists: ${message}`, error);
    }
    
    // Authentication/authorization
    if (message.includes('Unauthorized') || message.includes('Forbidden') || message.includes('does not have authorization')) {
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

df.app.activity(CREATE_VM_ACTIVITY, { handler: recCreateVmActivity });

export default recCreateVmActivity;