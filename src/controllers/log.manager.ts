// Log ingestion
import { ILogger } from '../common/logger';
import { LogsIngestionClient, isAggregateLogsUploadError } from "@azure/monitor-ingestion";
import { DefaultAzureCredential } from "@azure/identity";
import { LogIngestionError, LogIngestionAggregateError, _getString } from "../common/apperror";
import { LogEntry } from "../common/interfaces";


export class LogManager {

    private logClient: LogsIngestionClient;

    constructor(private logger: ILogger) {
        const credential = new DefaultAzureCredential();
        this.logClient = new LogsIngestionClient(process.env.LOGS_INGESTION_ENDPOINT, credential);
    }

    public async uploadLog(log: LogEntry) {

        try {
            if (!process.env.LOGS_INGESTION_ENDPOINT || !process.env.LOGS_INGESTION_RULE_ID || !process.env.LOGS_INGESTION_STREAM_NAME) {
                const message = "Environment variables LOGS_INGESTION_ENDPOINT, LOGS_INGESTION_RULE_ID and LOGS_INGESTION_STREAM_NAME must be set.";
                this.logger.error(message);
                throw new LogIngestionError(message);
            }

            const _logsData = {
                ...log,
                TimeGenerated: new Date().toISOString()
            };

            const result = await this.logClient.upload(process.env.LOGS_INGESTION_RULE_ID, process.env.LOGS_INGESTION_STREAM_NAME, [_logsData]);
        } catch (e) {
            let aggregateErrors = isAggregateLogsUploadError(e) ? e.errors : [];
            if (aggregateErrors.length > 0) {
                const message = `Unable to upload logs to Log Analytics with error: ${_getString(e)}`;
                this.logger.error(message);
                const listOfErrors: LogIngestionAggregateError[] = [];
                for (const error of aggregateErrors) {
                    listOfErrors.push({ error: JSON.stringify(error.cause), log: JSON.stringify(error.failedLogs) });
                }
                throw new LogIngestionError(message, listOfErrors);
            } else {
                const message = `Unable to upload logs to Log Analytics with error: ${_getString(e)}`;
                this.logger.error(message);
                throw new LogIngestionError(message);
            }
        }
    }

}
