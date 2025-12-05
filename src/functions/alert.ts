import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import axios from "axios";
import { AzureLogger } from '../common/logger';
import { _getString } from "../common/apperror";
import { mapSourceToTarget } from "../common/mapper";
import spec from '../alerts/mapping-type-01.json';

interface AlertResponse {
    success: boolean;
    message: string;
}

// Azure Monitor Common Alert Schema interfaces
interface CommonAlertSchema {
    schemaId: string;
    data: {
        essentials: {
            alertId: string;
            alertRule: string;
            severity: string;
            signalType: string;
            monitorCondition: string;
            monitoringService: string;
            alertTargetIDs: string[];
            originAlertId: string;
            firedDateTime: string;
            resolvedDateTime?: string;
            description: string;
            essentialsVersion: string;
            alertContextVersion: string;
        };
        alertContext: any;
    };
}

export async function alert(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const logger = new AzureLogger(context);
    
    try {
        // Parse the alert payload
        const alertPayload = await request.text();
        if (!alertPayload) {
            logger.warn("Received empty alert payload");
            return {
                status: 400,
                body: JSON.stringify({
                    success: false,
                    message: "Alert payload is required"
                } as AlertResponse)
            };
        }

        const alert: CommonAlertSchema = JSON.parse(alertPayload);
        
        // Validate common schema format
        if (!alert.schemaId || !alert.data?.essentials) {
            logger.error("Invalid alert schema format");
            return {
                status: 400,
                body: JSON.stringify({
                    success: false,
                    message: "Invalid Azure Monitor Common Alert Schema format"
                } as AlertResponse)
            };
        }

        //logger.info(`Received alert: ${alert.data.essentials.alertRule} - Severity: ${alert.data.essentials.severity} - Condition: ${alert.data.essentials.monitorCondition}`);
        logger.info(`Received alert: ${JSON.stringify(alert)}`);

        // Get webhook URL from environment variable
        const webhookUrl = process.env.SMCP_BCK_ALERT_WEBHOOK_URL;
        if (!webhookUrl) {
            logger.error("SMCP_BCK_ALERT_WEBHOOK_URL environment variable not configured");
            return {
                status: 500,
                body: JSON.stringify({
                    success: false,
                    message: "Webhook URL not configured"
                } as AlertResponse)
            };
        }

        // Optional: Transform or enrich the alert payload before forwarding
        const enrichedPayload = mapSourceToTarget(alert, spec);
        logger.info(`Transformed alert: ${JSON.stringify(enrichedPayload)}`);

        // Forward alert to external webhook
        const webhookTimeout = parseInt(process.env.SMCP_BCK_ALERT_WEBHOOK_TIMEOUT_MS || "10000", 10);
        const response = await axios.post(webhookUrl, enrichedPayload, {
            headers: {
                'Content-Type': 'application/json',
                // Optional: Add authentication header if webhook requires it
            },
            timeout: webhookTimeout
        });

        logger.info(`Alert forwarded successfully to webhook. Status: ${response.status}`);

        return {
            status: 200,
            body: JSON.stringify({
                success: true,
                message: `Alert ${alert.data.essentials.alertId} forwarded successfully`
            } as AlertResponse)
        };

    } catch (error) {
        const errorMsg = _getString(error);
        logger.error(`Failed to process alert: ${errorMsg}`);

        // Check if it's a webhook forwarding error
        if (axios.isAxiosError(error)) {
            const statusCode = error.response?.status || 500;
            const webhookError = error.response?.data || errorMsg;
            logger.error(`Webhook request failed with status ${statusCode}: ${JSON.stringify(webhookError)}`);
            
            return {
                status: 502, // Bad Gateway - indicates forwarding failure
                body: JSON.stringify({
                    success: false,
                    message: `Failed to forward alert to webhook: ${errorMsg}`
                } as AlertResponse)
            };
        }

        return {
            status: 500,
            body: JSON.stringify({
                success: false,
                message: `Alert processing failed: ${errorMsg}`
            } as AlertResponse)
        };
    }
}

app.http('alert', {
    methods: ['POST'],
    authLevel: 'function',
    handler: alert
});
