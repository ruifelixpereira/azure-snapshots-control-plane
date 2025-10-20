import * as df from 'durable-functions';
import { OrchestrationContext, OrchestrationHandler } from 'durable-functions';
import { GET_MOST_RECENT_SNAPSHOTS_ACTIVITY, CREATE_VM_ACTIVITY, CREATE_VM_ASYNC_ACTIVITY } from '../common/constants';
import { RecoveryBatch } from '../common/interfaces';
import { AzureLogger } from "../common/logger";
import { _getString } from '../common/apperror';
//import { executeActivityWithRetry, RetryPolicies } from '../common/retry-utils';
import { PermanentError, TransientError, FatalError, classifyError } from '../common/errors';


// Batch processing version (for large numbers of VMs)
const recRecoveryOrchestrator: OrchestrationHandler = function* (context: OrchestrationContext) {

    const logger = new AzureLogger(context);
    logger.info('Batch VM Recovery Orchestrator started');

    try {
        // Get input parameters from the orchestrator with proper typing
        const input = context.df.getInput() as RecoveryBatch;
        
        // Log the input details for debugging
        logger.info('Orchestrator input received:', {
            targetSubnetIds: input.targetSubnetIds,
            subnetCount: input.targetSubnetIds.length,
            targetResourceGroup: input.targetResourceGroup,
            maxTimeGenerated: input.maxTimeGenerated,
            useOriginalIpAddress: input.useOriginalIpAddress,
            waitForVmCreationCompletion: input.waitForVmCreationCompletion,
            appendUniqueStringToVmName: input.appendUniqueStringToVmName,
            vmFilterCount: input.vmFilter?.length || 0,
            batchId: input.batchId
        });

        // Extract parameters with defaults
        const batchSize = parseInt(process.env.SMCP_REC_BATCH_SIZE || '20');
        const delayBetweenBatches = parseInt(process.env.SMCP_REC_DELAY_BETWEEN_BATCHES || '10');

        // Get snapshots with parameters (with manual retry logic for orchestrator)
        let recoveryInfo;
        let lastError;
        const maxAttempts = 3;
        
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                recoveryInfo = yield context.df.callActivity(GET_MOST_RECENT_SNAPSHOTS_ACTIVITY, input);
                break; // Success, exit retry loop
            } catch (error) {
                const classifiedError = classifyError(error);
                lastError = classifiedError;
                
                logger.warn(`Get snapshots attempt ${attempt} failed:`, {
                    errorType: classifiedError.constructor.name,
                    isRetryable: !(classifiedError instanceof PermanentError || classifiedError instanceof FatalError),
                    message: classifiedError.message,
                    attempt,
                    maxAttempts
                });
                
                // Don't retry permanent or fatal errors
                if (classifiedError instanceof PermanentError || classifiedError instanceof FatalError) {
                    throw classifiedError;
                }
                
                // Don't retry if this was the last attempt
                if (attempt >= maxAttempts) {
                    break;
                }
                
                // Add delay before retry (exponential backoff)
                const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 30000);
                const delayTime = context.df.currentUtcDateTime;
                delayTime.setMilliseconds(delayTime.getMilliseconds() + delayMs);
                yield context.df.createTimer(delayTime);
            }
        }
        
        if (!recoveryInfo) {
            throw lastError || new Error('Failed to get snapshots after retries');
        }

        if (!recoveryInfo?.snapshots?.length || !recoveryInfo?.subnetLocations?.length) {
            return { success: false, message: `No snapshots found in the same region of subnets ${input.targetSubnetIds.join(', ')}` };
        }
        
        // Start process
        logger.info(`Starting the restore for ${recoveryInfo.snapshots.length} VMs`);

        const allResults = [];
        
        // Process in batches
        for (let i = 0; i < recoveryInfo.snapshots.length; i += batchSize) {
            const batch = recoveryInfo.snapshots.slice(i, i + batchSize);

            // Batch start
            logger.info(`Processing batch ${Math.floor(i / batchSize) + 1} with ${batch.length} VMs`);

            const batchTasks = batch.map((snapshot, index) => {
                // Find a subnet in the same location as the snapshot
                const matchingSubnet = recoveryInfo.subnetLocations.find(
                    subnetLocation => subnetLocation.location === snapshot.location
                );
                
                if (!matchingSubnet) {
                    // Return a resolved "task" for missing subnet
                    return Promise.resolve({ 
                        success: false, 
                        message: `No subnet found in location ${snapshot.location} for snapshot ${snapshot.snapshotName}`,
                        snapshot: snapshot.snapshotName 
                    });
                }
                
                // Create VM activity call (with WAIT or NO WAIT)
                if (input.waitForVmCreationCompletion) {
                    // Wait for VM creation to complete
                    return context.df.callActivity(CREATE_VM_ACTIVITY, {
                        targetSubnetId: matchingSubnet.subnetId,
                        targetResourceGroup: input.targetResourceGroup,
                        useOriginalIpAddress: input.useOriginalIpAddress,
                        appendUniqueStringToVmName: input.appendUniqueStringToVmName,
                        sourceSnapshot: snapshot,
                        batchId: input.batchId
                    });
                }
                else {
                    return context.df.callActivity(CREATE_VM_ASYNC_ACTIVITY, {
                        targetSubnetId: matchingSubnet.subnetId,
                        targetResourceGroup: input.targetResourceGroup,
                        useOriginalIpAddress: input.useOriginalIpAddress,
                        appendUniqueStringToVmName: input.appendUniqueStringToVmName,
                        sourceSnapshot: snapshot,
                        batchId: input.batchId
                    });
                    
                }
            });
            
            const batchResults = yield context.df.Task.all(batchTasks);
            
            // Process results and log any failures
            const successCount = batchResults.filter(result => result.success !== false).length;
            const failureCount = batchResults.length - successCount;
            
            if (failureCount > 0) {
                logger.warn(`Batch ${Math.floor(i / batchSize) + 1} completed with ${failureCount} failures:`, {
                    successCount,
                    failureCount,
                    totalInBatch: batchResults.length
                });
                
                // Log individual failures
                batchResults.forEach((result, index) => {
                    if (result.success === false) {
                        logger.error(`Failed VM creation in batch:`, {
                            snapshot: result.snapshot || `batch[${index}]`,
                            error: result.message,
                            errorType: result.errorType || 'unknown',
                            isRetryable: result.isRetryable
                        });
                    }
                });
            } else {
                logger.info(`Batch ${Math.floor(i / batchSize) + 1} completed successfully: ${successCount} VMs created`);
            }
            
            allResults.push(...batchResults);

            // Optional: Add delay between batches to avoid rate limits
            if (i + batchSize < recoveryInfo.snapshots.length && delayBetweenBatches > 0) {
                const delay = context.df.currentUtcDateTime;
                delay.setSeconds(delay.getSeconds() + delayBetweenBatches);
                yield context.df.createTimer(delay);
            }
            
        }

        // Calculate final statistics
        const totalSuccessful = allResults.filter(result => result.success !== false).length;
        const totalFailed = allResults.length - totalSuccessful;
        
        logger.info(`Batch orchestrator completed:`, {
            totalProcessed: allResults.length,
            successful: totalSuccessful,
            failed: totalFailed,
            successRate: totalSuccessful / allResults.length
        });

        return {
            success: totalSuccessful > 0, // Success if at least one VM was created
            totalProcessed: allResults.length,
            successful: totalSuccessful,
            failed: totalFailed,
            input: input, // Include original input for reference
            results: allResults
        };
        
    } catch (error) {
        const classifiedError = classifyError(error);
        logger.error('Batch orchestrator failed:', {
            errorType: classifiedError.constructor.name,
            message: classifiedError.message,
            isRetryable: !(classifiedError instanceof PermanentError || classifiedError instanceof FatalError)
        });
        
        // For orchestrator failures, we typically want to fail the entire operation
        throw classifiedError;
    }
};

// Register orchestrators
df.app.orchestration('recRecoveryOrchestrator', recRecoveryOrchestrator);

export { recRecoveryOrchestrator };