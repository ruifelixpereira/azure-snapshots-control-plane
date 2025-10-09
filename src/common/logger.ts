// logger.ts
// This file defines a logger interface and an implementation for Azure Functions.

import { InvocationContext } from '@azure/functions';

export interface ILogger {
  info(message: string, ...meta: any[]): void;
  warn(message: string, ...meta: any[]): void;
  error(message: string, ...meta: any[]): void;
  debug(message: string, ...meta: any[]): void;
}

export class AzureLogger implements ILogger {
  constructor(private context: InvocationContext) {}

  info(message: string, ...meta: any[]) {
    this.context.log(message, ...meta);
  }

  warn(message: string, ...meta: any[]) {
    this.context.warn(message, ...meta);
  }

  error(message: string, ...meta: any[]) {
    this.context.error(message, ...meta);
  }

  debug(message: string, ...meta: any[]) {
    if (process.env.NODE_ENV !== 'production') {
      this.context.log('[DEBUG]', message, ...meta);
    }
  }

  // Helper method to add correlation ID to all logs
  logWithCorrelation(level: 'info' | 'warn' | 'error' | 'debug', message: string, ...meta: any[]) {
    const correlationId = this.context.invocationId;
    const functionName = this.context.functionName;
    
    this[level](`[${functionName}] [${correlationId}] ${message}`, ...meta);
  }
}
