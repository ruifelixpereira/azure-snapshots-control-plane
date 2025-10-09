// Log ingestion
import { ILogger } from '../common/logger';
import { LogsIngestionClient, isAggregateLogsUploadError } from "@azure/monitor-ingestion";
import { DefaultAzureCredential } from "@azure/identity";
import { LogIngestionError, LogIngestionAggregateError, _getString } from "../common/apperror";
import { BackupJobLogEntry, RecoveryJobLogEntry } from "../common/interfaces";


export class BackupLogManager {

    private logClient: LogsIngestionClient;

    constructor(private logger: ILogger) {
        const credential = new DefaultAzureCredential();
        this.logClient = new LogsIngestionClient(process.env.SMCP_BCK_LOGS_INGESTION_ENDPOINT, credential);
    }

    public async uploadLog(log: BackupJobLogEntry) {

        try {
            if (!process.env.SMCP_BCK_LOGS_INGESTION_ENDPOINT || !process.env.SMCP_BCK_LOGS_INGESTION_RULE_ID || !process.env.SMCP_BCK_LOGS_INGESTION_STREAM_NAME) {
                const message = "Environment variables SMCP_BCK_LOGS_INGESTION_ENDPOINT, SMCP_BCK_LOGS_INGESTION_RULE_ID and SMCP_BCK_LOGS_INGESTION_STREAM_NAME must be set.";
                this.logger.error(message);
                throw new LogIngestionError(message);
            }

            const _logsData = {
                ...log,
                TimeGenerated: new Date().toISOString()
            };

            const result = await this.logClient.upload(process.env.SMCP_BCK_LOGS_INGESTION_RULE_ID, process.env.SMCP_BCK_LOGS_INGESTION_STREAM_NAME, [_logsData]);
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


export class RecoveryLogManager {

    private logClient: LogsIngestionClient;

    constructor(private logger: ILogger) {
        const credential = new DefaultAzureCredential();
        this.logClient = new LogsIngestionClient(process.env.SMCP_REC_LOGS_INGESTION_ENDPOINT, credential);
    }

    public async uploadLog(log: RecoveryJobLogEntry) {

        try {
            if (!process.env.SMCP_REC_LOGS_INGESTION_ENDPOINT || !process.env.SMCP_REC_LOGS_INGESTION_RULE_ID || !process.env.SMCP_REC_LOGS_INGESTION_STREAM_NAME) {
                const message = "Environment variables SMCP_REC_LOGS_INGESTION_ENDPOINT, SMCP_REC_LOGS_INGESTION_RULE_ID and SMCP_REC_LOGS_INGESTION_STREAM_NAME must be set.";
                this.logger.error(message);
                throw new LogIngestionError(message);
            }

            const _logsData = {
                ...log,
                TimeGenerated: new Date().toISOString()
            };

            const result = await this.logClient.upload(process.env.SMCP_REC_LOGS_INGESTION_RULE_ID, process.env.SMCP_REC_LOGS_INGESTION_STREAM_NAME, [_logsData]);
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

/*
    async function sendLogToAzureMonitor(vmName: string, status: string, message: string) {
        const timestamp = new Date().toISOString();
        const body = JSON.stringify([{ VMName: vmName, Status: status, Message: message, Timestamp: timestamp }]);
        const date = new Date().toUTCString();
        const contentLength = Buffer.byteLength(body, 'utf8');
        const stringToSign = `POST\n${contentLength}\napplication/json\nx-ms-date:${date}\n/api/logs`;
        const crypto = require("crypto");
        const signature = crypto.createHmac("sha256", Buffer.from(logAnalyticsKey, 'base64'))
            .update(stringToSign, 'utf8')
            .digest('base64');
        const auth = `SharedKey ${logAnalyticsWorkspaceId}:${signature}`;

        await axios.post(`https://${logAnalyticsWorkspaceId}.ods.opinsights.azure.com/api/logs?api-version=2016-04-01`, body, {
            headers: {
                "Content-Type": "application/json",
                "Log-Type": logType,
                "x-ms-date": date,
                "Authorization": auth
            }
        });
    }
*/
}
