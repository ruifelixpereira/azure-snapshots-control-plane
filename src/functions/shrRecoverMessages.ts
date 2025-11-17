import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { AzureLogger } from '../common/logger';
import { QueueManager } from "../controllers/queue.manager";
import { _getString } from "../common/apperror";

interface RecoverMessagesRequest {
    sourceQueue: {
        accountName: string;
        queueName: string;
    };
    destinationQueue: {
        accountName: string;
        queueName: string;
    };
    maxMessages?: number; // Optional limit on messages to move
    deleteSource?: boolean; // Whether to delete from source after successful copy
}

interface RecoverMessagesResponse {
    success: boolean;
    message: string;
    movedCount: number;
    failedCount: number;
    errors?: string[];
}

export async function shrRecoverMessages(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const logger = new AzureLogger(context);
    
    try {
        // Parse request body
        const requestBody = await request.text();
        if (!requestBody) {
            return {
                status: 400,
                body: JSON.stringify({
                    success: false,
                    message: "Request body is required",
                    movedCount: 0,
                    failedCount: 0
                } as RecoverMessagesResponse)
            };
        }

        const requestData: RecoverMessagesRequest = JSON.parse(requestBody);
        
        // Validate required fields
        if (!requestData.sourceQueue?.accountName || !requestData.sourceQueue?.queueName ||
            !requestData.destinationQueue?.accountName || !requestData.destinationQueue?.queueName) {
            return {
                status: 400,
                body: JSON.stringify({
                    success: false,
                    message: "Source and destination queue configurations (accountName and queueName) are required",
                    movedCount: 0,
                    failedCount: 0
                } as RecoverMessagesResponse)
            };
        }

        logger.info(`Starting message recovery from ${requestData.sourceQueue.accountName}/${requestData.sourceQueue.queueName} to ${requestData.destinationQueue.accountName}/${requestData.destinationQueue.queueName}`);

        // Initialize queue managers
        const sourceQueueManager = new QueueManager(logger, requestData.sourceQueue.accountName, requestData.sourceQueue.queueName);
        const destQueueManager = new QueueManager(logger, requestData.destinationQueue.accountName, requestData.destinationQueue.queueName);

        const maxMessages = requestData.maxMessages || 32; // Default Azure Storage Queue limit
        const deleteSource = requestData.deleteSource ?? true; // Default to delete after move
        
        let movedCount = 0;
        let failedCount = 0;
        const errors: string[] = [];
        let hasMoreMessages = true;

        while (hasMoreMessages && (requestData.maxMessages ? movedCount < requestData.maxMessages : true)) {
            try {
                // Receive messages from source queue
                const messages = await sourceQueueManager.receiveMessages(Math.min(maxMessages, (requestData.maxMessages || Number.MAX_SAFE_INTEGER) - movedCount));
                
                if (!messages || messages.length === 0) {
                    hasMoreMessages = false;
                    break;
                }

                logger.info(`Retrieved ${messages.length} messages from source queue`);

                // Process each message
                for (const message of messages) {
                    try {
                        // Send message to destination queue
                        const msgText = Buffer.from(message.messageText, 'base64').toString('utf-8');
                        await destQueueManager.sendMessage(msgText, 0); // Immediate visibility

                        // Delete from source queue if requested
                        if (deleteSource) {
                            await sourceQueueManager.deleteMessage(message);
                        }
                        
                        movedCount++;
                        logger.info(`Successfully moved message ${message.messageId}`);
                        
                    } catch (msgError) {
                        failedCount++;
                        const errorMsg = `Failed to move message ${message.messageId}: ${_getString(msgError)}`;
                        logger.error(errorMsg);
                        errors.push(errorMsg);
                        
                        // If we can't delete the message from source, it will become visible again
                        // This is actually good for retry scenarios
                    }
                }

                // Check if we should continue (fewer messages than requested means we're done)
                if (messages.length < maxMessages) {
                    hasMoreMessages = false;
                }

            } catch (batchError) {
                const errorMsg = `Failed to retrieve messages from source queue: ${_getString(batchError)}`;
                logger.error(errorMsg);
                errors.push(errorMsg);
                hasMoreMessages = false;
            }
        }

        const response: RecoverMessagesResponse = {
            success: failedCount === 0,
            message: `Message recovery completed. Moved: ${movedCount}, Failed: ${failedCount}`,
            movedCount,
            failedCount,
            ...(errors.length > 0 && { errors })
        };

        logger.info(`Message recovery completed: ${JSON.stringify(response)}`);

        return {
            status: failedCount === 0 ? 200 : 207, // 207 Multi-Status if some failed
            body: JSON.stringify(response)
        };

    } catch (error) {
        const errorMsg = `Message recovery function failed: ${_getString(error)}`;
        logger.error(errorMsg);
        
        return {
            status: 500,
            body: JSON.stringify({
                success: false,
                message: errorMsg,
                movedCount: 0,
                failedCount: 0
            } as RecoverMessagesResponse)
        };
    }
}

app.http('shrRecoverMessages', {
    methods: ['POST'],
    authLevel: 'function',
    handler: shrRecoverMessages
});
