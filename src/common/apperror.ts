export class AppError extends Error {
    
    constructor(error: any) {
        const message = error instanceof Error ? error.message : error;
        super(message);
        Object.setPrototypeOf(this, AppError.prototype);
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


export class ResourceGroupTagsError extends AppError {
    
    constructor(error: any) {
        super(error);
        Object.setPrototypeOf(this, ResourceGroupTagsError.prototype);
    }

}

export class StorageQueueError extends AppError {
    
    constructor(error: any) {
        super(error);
        Object.setPrototypeOf(this, StorageQueueError.prototype);
    }

}

export class KeyVaultError extends AppError {
    
    constructor(error: any) {
        super(error);
        Object.setPrototypeOf(this, KeyVaultError.prototype);
    }

}

export class SnapshotError extends AppError {
    
    constructor(error: any) {
        super(error);
        Object.setPrototypeOf(this, SnapshotError.prototype);
    }

}

export class ResourceGraphError extends AppError {
    
    constructor(error: any) {
        super(error);
        Object.setPrototypeOf(this, ResourceGraphError.prototype);
    }

}

export interface LogIngestionAggregateError {
    error: string;
    log: string;
}

export class LogIngestionError extends AppError {

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
