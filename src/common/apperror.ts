export class AppComponentError extends Error {
    
    constructor(error: any) {
        const message = error instanceof Error ? error.message : error;
        super(message);
        Object.setPrototypeOf(this, AppComponentError.prototype);
    }

}

export function _getString(data: any) {
    if (!data) {
      return null;
    }

    if (typeof data === 'string') {
      return data;
    }

    if (data.toString !== Object.toString) {
      return data.toString();
    }

    return JSON.stringify(data);
}

export function ensureErrorType(err: unknown): Error {
    if (err instanceof Error) {
        return err;
    } else {
        let message: string;
        if (err === undefined || err === null) {
            message = 'Unknown error';
        } else if (typeof err === 'string') {
            message = err;
        } else if (typeof err === 'object') {
            message = JSON.stringify(err);
        } else {
            message = String(err);
        }
        return new Error(message);
    }
}


export function isRetryableError(error: any): boolean {
    const message = error.message || error.toString();

    // Check transient status code
    let isTransientStatusCode = false;
    
    if (error.statusCode) {

        isTransientStatusCode = [
            408, // Request Timeout
            429, // Too Many Requests
            500, // Internal Server Error
            502, // Bad Gateway
            503, // Service Unavailable
            504  // Gateway Timeout
            ].includes(error.statusCode);
    }

    // Detect too many requests limit error (service message)
    const isRetryableError = /too many requests|try after|retry the request later|quota|rate limit|throttle|limit|timeout|service is unavailable now|getaddrinfo|EAI_AGAIN|Please provide below info when asking for support/i.test(message);
    
    return (isRetryableError || isTransientStatusCode);
}

export class ResourceGroupTagsError extends AppComponentError {
    
    constructor(error: any) {
        super(error);
        Object.setPrototypeOf(this, ResourceGroupTagsError.prototype);
    }

}

export class StorageQueueError extends AppComponentError {
    
    constructor(error: any) {
        super(error);
        Object.setPrototypeOf(this, StorageQueueError.prototype);
    }

}

export class KeyVaultError extends AppComponentError {
    
    constructor(error: any) {
        super(error);
        Object.setPrototypeOf(this, KeyVaultError.prototype);
    }

}

export class VmError extends AppComponentError {
    
    constructor(error: any) {
        super(error);
        Object.setPrototypeOf(this, VmError.prototype);
    }

}

export class ResourceGraphError extends AppComponentError {
    
    constructor(error: any) {
        super(error);
        Object.setPrototypeOf(this, ResourceGraphError.prototype);
    }

}

export class SnapshotError extends AppComponentError {
    
    constructor(error: any) {
        super(error);
        Object.setPrototypeOf(this, SnapshotError.prototype);
    }

}

export interface LogIngestionAggregateError {
    error: string;
    log: string;
}

export class LogIngestionError extends AppComponentError {

    public aggregateErrors?: LogIngestionAggregateError[];

    constructor(error: any, aggregateErrors?: LogIngestionAggregateError[]) {
        super(error);
        this.aggregateErrors = aggregateErrors;
        Object.setPrototypeOf(this, LogIngestionError.prototype);
    }

    public get hasAggregateErrors(): boolean {  
        return this.aggregateErrors && this.aggregateErrors.length > 0;
    }


}
