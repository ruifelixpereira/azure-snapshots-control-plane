import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { AzureLogger } from '../common/logger';
import { _getString } from "../common/apperror";


interface DumpResponse {
    success: boolean;
    message: string;
}


export async function dump(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const logger = new AzureLogger(context);
    
    try {
        // Parse the dump payload
        const dumpPayload = await request.text();
        if (!dumpPayload) {
            logger.warn("Received empty dump payload");
            return {
                status: 400,
                body: JSON.stringify({
                    success: false,
                    message: "Dump payload is required"
                } as DumpResponse)
            };
        }

        logger.info(`Received dump: ${dumpPayload}`);

        return {
            status: 200,
            body: JSON.stringify({
                success: true,
                message: `Dump processed successfully`
            } as DumpResponse)
        };

    } catch (error) {
        const errorMsg = _getString(error);
        logger.error(`Failed to process dump: ${errorMsg}`);
        
        return {
            status: 500,
            body: JSON.stringify({
                success: false,
                message: `Dump processing failed: ${errorMsg}`
            } as DumpResponse)
        };
    }
}

app.http('dump', {
    methods: ['POST'],
    authLevel: 'function',
    handler: dump
});
