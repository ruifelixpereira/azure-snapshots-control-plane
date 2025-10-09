// Custom error classes for Durable Functions

/**
 * Base class for all application errors
 */
export abstract class AppError extends Error {
    abstract readonly isRetryable: boolean;
    abstract readonly errorType: string;
    
    constructor(message: string, public readonly details?: any) {
        super(message);
        this.name = this.constructor.name;
        
        // Maintain proper stack trace
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, this.constructor);
        }
    }
}

/**
 * Permanent errors that should not be retried
 * Examples: Invalid input, resource not found, authorization failures
 */
export class PermanentError extends AppError {
    readonly isRetryable = false;
    readonly errorType = 'PERMANENT';
    
    constructor(message: string, details?: any) {
        super(message, details);
    }
}

/**
 * Transient errors that can be retried
 * Examples: Network timeouts, rate limiting, temporary service unavailability
 */
export class TransientError extends AppError {
    readonly isRetryable = true;
    readonly errorType = 'TRANSIENT';
    
    constructor(message: string, details?: any) {
        super(message, details);
    }
}

/**
 * Fatal errors that should fail the entire orchestration
 * Examples: Configuration errors, critical system failures
 */
export class FatalError extends AppError {
    readonly isRetryable = false;
    readonly errorType = 'FATAL';
    
    constructor(message: string, details?: any) {
        super(message, details);
    }
}

/**
 * Business logic errors (validation, business rules)
 */
export class BusinessError extends PermanentError {
    //readonly errorType = 'BUSINESS';
    
    constructor(message: string, details?: any) {
        super(message, details);
    }
}

/**
 * Azure-specific errors with retry logic
 */
export class AzureError extends AppError {
    readonly isRetryable: boolean;
    readonly errorType = 'AZURE';
    
    constructor(
        message: string, 
        public readonly statusCode?: number,
        public readonly azureErrorCode?: string,
        details?: any
    ) {
        super(message, details);
        
        // Determine if retryable based on status code
        this.isRetryable = this.isRetryableStatusCode(statusCode);
    }
    
    private isRetryableStatusCode(statusCode?: number): boolean {
        if (!statusCode) return false;
        
        return [
            408, // Request Timeout
            429, // Too Many Requests
            500, // Internal Server Error
            502, // Bad Gateway
            503, // Service Unavailable
            504  // Gateway Timeout
        ].includes(statusCode);
    }
}

/**
 * Error classification utility
 */
export function classifyError(error: any): AppError {
    // Already classified
    if (error instanceof AppError) {
        return error;
    }
    
    // Azure SDK errors
    if (error.statusCode || error.code) {
        return new AzureError(
            error.message || 'Azure operation failed',
            error.statusCode,
            error.code,
            error
        );
    }
    
    // Network/timeout errors
    if (error.code === 'ETIMEDOUT' || error.code === 'ECONNRESET') {
        return new TransientError(`Network error: ${error.message}`, error);
    }
    
    // Validation errors
    if (error.name === 'ValidationError' || error.message?.includes('validation')) {
        return new BusinessError(`Validation failed: ${error.message}`, error);
    }
    
    // Default to transient for unknown errors (can be overridden)
    return new TransientError(`Unknown error: ${error.message}`, error);
}
