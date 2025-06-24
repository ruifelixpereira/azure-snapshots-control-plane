// logger.ts
// This file defines a logger interface and an implementation for Azure Functions.

export interface ILogger {
  info(message: string, ...meta: any[]): void;
  warn(message: string, ...meta: any[]): void;
  error(message: string, ...meta: any[]): void;
  debug(message: string, ...meta: any[]): void;
}

export class AzureLogger implements ILogger {
  constructor(private context: any) {}

  info(message: string, ...meta: any[]) {
    this.context.info(message, ...meta);
  }

  warn(message: string, ...meta: any[]) {
    this.context.warn(message, ...meta);
  }

  error(message: string, ...meta: any[]) {
    this.context.error(message, ...meta);
  }

  debug(message: string, ...meta: any[]) {
    if (process.env.NODE_ENV !== 'production') {
      this.context.debug(message, ...meta);
    }
  }
}
