// Error handling utilities for orchestrators

import { OrchestrationContext } from 'durable-functions';
import { AppError, PermanentError, TransientError, FatalError, classifyError } from './errors';

/**
 * Retry policy configuration
 */
export interface RetryConfig {
    maxAttempts: number;
    initialDelayMs: number;
    maxDelayMs: number;
    backoffMultiplier: number;
}

/**
 * Default retry configurations for different error types
 */
export const RetryPolicies = {
    // For transient errors (network, rate limiting)
    transient: {
        maxAttempts: 5,
        initialDelayMs: 1000,
        maxDelayMs: 30000,
        backoffMultiplier: 2
    },
    
    // For Azure service errors
    azure: {
        maxAttempts: 3,
        initialDelayMs: 2000,
        maxDelayMs: 20000,
        backoffMultiplier: 1.5
    },
    
    // For critical operations
    critical: {
        maxAttempts: 7,
        initialDelayMs: 500,
        maxDelayMs: 60000,
        backoffMultiplier: 2
    }
};

/**
 * Execute activity with retry logic based on error classification
 */
export async function* executeActivityWithRetry<T>(
    context: OrchestrationContext,
    activityName: string,
    input: any,
    retryConfig: RetryConfig = RetryPolicies.transient
): AsyncGenerator<any, T, any> {
    let lastError: AppError | undefined;
    
    for (let attempt = 1; attempt <= retryConfig.maxAttempts; attempt++) {
        try {
            // Execute the activity
            const result = yield context.df.callActivity(activityName, input);
            return result;
            
        } catch (error) {
            const classifiedError = classifyError(error);
            lastError = classifiedError;
            
            context.log(`Activity ${activityName} attempt ${attempt} failed:`, {
                errorType: classifiedError.errorType,
                isRetryable: classifiedError.isRetryable,
                message: classifiedError.message,
                attempt,
                maxAttempts: retryConfig.maxAttempts
            });
            
            // Don't retry permanent or fatal errors
            if (!classifiedError.isRetryable) {
                context.log(`Non-retryable error in ${activityName}:`, classifiedError.message);
                throw classifiedError;
            }
            
            // Don't retry if this was the last attempt
            if (attempt >= retryConfig.maxAttempts) {
                context.log(`Max retry attempts (${retryConfig.maxAttempts}) reached for ${activityName}`);
                break;
            }
            
            // Calculate delay with exponential backoff
            const delay = Math.min(
                retryConfig.initialDelayMs * Math.pow(retryConfig.backoffMultiplier, attempt - 1),
                retryConfig.maxDelayMs
            );
            
            context.log(`Retrying ${activityName} in ${delay}ms (attempt ${attempt + 1}/${retryConfig.maxAttempts})`);
            
            // Wait before retry
            const retryTime = context.df.currentUtcDateTime;
            retryTime.setMilliseconds(retryTime.getMilliseconds() + delay);
            yield context.df.createTimer(retryTime);
        }
    }
    
    // If we get here, all retries failed
    throw lastError;
}

/**
 * Execute multiple activities with different retry policies
 */
export async function* executeActivitiesWithErrorHandling(
    context: OrchestrationContext,
    activities: Array<{
        name: string;
        input: any;
        retryConfig?: RetryConfig;
        required?: boolean; // If false, continue on failure
    }>
): AsyncGenerator<any, any[], any> {
    const results: any[] = [];
    const errors: AppError[] = [];
    
    for (const activity of activities) {
        try {
            const result = yield* executeActivityWithRetry(
                context,
                activity.name,
                activity.input,
                activity.retryConfig || RetryPolicies.transient
            );
            results.push(result);
            
        } catch (error) {
            const classifiedError = classifyError(error);
            errors.push(classifiedError);
            
            // If activity is required, fail immediately
            if (activity.required !== false) {
                throw classifiedError;
            }
            
            // Log and continue for optional activities
            context.log(`Optional activity ${activity.name} failed, continuing:`, classifiedError.message);
            results.push(null);
        }
    }
    
    return results;
}

/**
 * Circuit breaker pattern for activities that fail frequently
 */
export class CircuitBreaker {
    private failures = 0;
    private lastFailureTime = 0;
    private state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED';
    
    constructor(
        private readonly failureThreshold: number = 5,
        private readonly timeoutMs: number = 60000
    ) {}
    
    async execute<T>(operation: () => Promise<T>): Promise<T> {
        if (this.state === 'OPEN') {
            if (Date.now() - this.lastFailureTime > this.timeoutMs) {
                this.state = 'HALF_OPEN';
            } else {
                throw new TransientError('Circuit breaker is OPEN');
            }
        }
        
        try {
            const result = await operation();
            
            if (this.state === 'HALF_OPEN') {
                this.state = 'CLOSED';
                this.failures = 0;
            }
            
            return result;
            
        } catch (error) {
            this.failures++;
            this.lastFailureTime = Date.now();
            
            if (this.failures >= this.failureThreshold) {
                this.state = 'OPEN';
            }
            
            throw error;
        }
    }
}