import * as df from 'durable-functions';
import { ActivityHandler } from 'durable-functions';
import { InvocationContext } from '@azure/functions';

import { GET_MOST_RECENT_SNAPSHOTS_ACTIVITY } from '../common/constants';
import { AzureLogger } from "../common/logger";
import { ResourceGraphManager } from "../controllers/graph.manager";
import { RecoveryBatch, RecoveryInfo, SubnetLocation } from '../common/interfaces';
import { AzureLocationResolver } from '../common/azure-location-resolver';
import { PermanentError, TransientError, BusinessError, classifyError } from '../common/errors';

// Activity functions receive context as the second parameter
const recGetSnapshotsActivity: ActivityHandler = async (input: RecoveryBatch, context: InvocationContext): Promise<RecoveryInfo> => {

    const logger = new AzureLogger(context);
    logger.info('Activity function recGetSnapshotsActivity trigger request.');

    try {
        // Input validation (permanent errors)
        if (!input) {
            throw new PermanentError('Input is required');
        }
        if (!input.targetSubnetIds || !Array.isArray(input.targetSubnetIds)) {
            throw new PermanentError('targetSubnetIds array is required');
        }
        if (input.targetSubnetIds.length === 0) {
            throw new PermanentError('At least one target subnet ID is required');
        }
        if (!input.maxSnapshotTimeGenerated) {
            throw new PermanentError('maxSnapshotTimeGenerated is required');
        }

        // Validate date format
        const maxTimeDate = new Date(input.maxSnapshotTimeGenerated);
        if (isNaN(maxTimeDate.getTime())) {
            throw new PermanentError(`Invalid date format for maxSnapshotTimeGenerated: ${input.maxSnapshotTimeGenerated}`);
        }

        logger.info(`Processing request for snapshots targeting ${input.targetSubnetIds.length} subnets, max time: ${input.maxSnapshotTimeGenerated}`);

        // Get the locations for all subnet IDs using the new resolver
        let subnetLocations: SubnetLocation[];
        try {
            const locationResolver = new AzureLocationResolver(logger);
            subnetLocations = await locationResolver.getSubnetLocations(input.targetSubnetIds);
            
            if (!subnetLocations || subnetLocations.length === 0) {
                throw new BusinessError('No valid subnet locations found for the provided subnet IDs');
            }
        } catch (error) {
            const classifiedError = classifyLocationResolverError(error);
            throw classifiedError;
        }
        
        // Get unique locations from all subnets
        const uniqueLocations: string[] = [...new Set(subnetLocations.map((sl: SubnetLocation) => sl.location))];
        logger.info(`Determined ${uniqueLocations.length} unique locations: ${uniqueLocations.join(', ')} for ${subnetLocations.length} subnets`);

        // Get snapshots from all regions
        let snapshots;
        try {
            const graphManager = new ResourceGraphManager(logger);
            snapshots = await graphManager.getMostRecentSnapshotsInRegions(uniqueLocations, maxTimeDate, input.sourceVmFilter, input.sourceSubnetIdFilter);
            
            if (!snapshots) {
                snapshots = [];
            }
            
            logger.info(`Found ${snapshots.length} snapshots in regions ${uniqueLocations.join(', ')}`);
        } catch (error) {
            const classifiedError = classifyResourceGraphError(error);
            throw classifiedError;
        }
        
        return { snapshots, subnetLocations };

    } catch (error) {
        // Log error details for debugging
        logger.error('Get snapshots activity failed:', {
            error: error.message,
            errorType: error.constructor.name,
            targetSubnetCount: input?.targetSubnetIds?.length || 0,
            maxSnapshotTimeGenerated: input?.maxSnapshotTimeGenerated
        });
        
        // Ensure error is properly classified
        const classifiedError = classifyError(error);
        
        // Add context to the error
        if (classifiedError instanceof PermanentError) {
            logger.error('Permanent error - will not retry:', classifiedError.message);
        } else if (classifiedError instanceof TransientError) {
            logger.warn('Transient error - eligible for retry:', classifiedError.message);
        }
        
        throw classifiedError;
    }

};

/**
 * Classify errors from Location Resolver operations
 */
function classifyLocationResolverError(error: any): Error {
    const message = error.message || error.toString();
    
    // Authentication/authorization
    if (message.includes('Unauthorized') || message.includes('Forbidden')) {
        return new PermanentError(`Location resolution failed - authentication/authorization error: ${message}`, error);
    }
    
    // Invalid subnet ID format
    if (message.includes('Invalid') || message.includes('malformed') || message.includes('format')) {
        return new PermanentError(`Location resolution failed - invalid subnet ID format: ${message}`, error);
    }
    
    // Subnet not found
    if (message.includes('NotFound') || message.includes('does not exist') || message.includes('not found') || message.includes('status: 404')) {
        return new PermanentError(`Location resolution failed - subnet not found: ${message}`, error);
    }
    
    // Network/connectivity issues
    if (message.includes('timeout') || message.includes('network') || message.includes('connection')) {
        return new TransientError(`Location resolution failed due to network issues: ${message}`, error);
    }
    
    // Rate limiting
    if (message.includes('throttle') || message.includes('rate limit')) {
        return new TransientError(`Location resolution failed due to rate limiting: ${message}`, error);
    }
    
    // Default classification
    return classifyError(error);
}

/**
 * Classify errors from Resource Graph operations
 */
function classifyResourceGraphError(error: any): Error {
    const message = error.message || error.toString();
    
    // Authentication/authorization
    if (message.includes('Unauthorized') || message.includes('Forbidden')) {
        return new PermanentError(`Resource Graph query failed - authentication/authorization error: ${message}`, error);
    }
    
    // Invalid query or parameters
    if (message.includes('Invalid query') || message.includes('BadRequest') || message.includes('invalid syntax')) {
        return new PermanentError(`Resource Graph query failed - invalid query: ${message}`, error);
    }
    
    // Quota or limit exceeded
    if (message.includes('quota') || message.includes('limit') || message.includes('TooManyRequests')) {
        return new TransientError(`Resource Graph query failed due to quota limits: ${message}`, error);
    }
    
    // Network/connectivity issues
    if (message.includes('timeout') || message.includes('network') || message.includes('connection')) {
        return new TransientError(`Resource Graph query failed due to network issues: ${message}`, error);
    }
    
    // Rate limiting
    if (message.includes('throttle') || message.includes('rate limit')) {
        return new TransientError(`Resource Graph query failed due to rate limiting: ${message}`, error);
    }
    
    // Service unavailable
    if (message.includes('ServiceUnavailable') || message.includes('InternalServerError')) {
        return new TransientError(`Resource Graph service temporarily unavailable: ${message}`, error);
    }
    
    // Default classification
    return classifyError(error);
}

df.app.activity(GET_MOST_RECENT_SNAPSHOTS_ACTIVITY, { handler: recGetSnapshotsActivity });

export default recGetSnapshotsActivity;