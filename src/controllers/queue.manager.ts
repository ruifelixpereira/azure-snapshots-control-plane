// Storage queues
import { ILogger } from '../common/logger';
import { QueueServiceClient } from "@azure/storage-queue"
import { DefaultAzureCredential } from "@azure/identity";
import { StorageQueueError, _getString } from "../common/apperror";
import { VmCreationPollMessage } from '../common/interfaces';


export class QueueManager {

    private queueServiceClient: QueueServiceClient;
    private queueName: string;

    constructor(private logger: ILogger, accountName: string, queue: string) {
        const credential = new DefaultAzureCredential();
        this.queueServiceClient = new QueueServiceClient(`https://${accountName}.queue.core.windows.net`, credential);
        this.queueName = queue;
    }

    public async sendMessage(message: string, visibilityTimeoutSeconds?: number): Promise<void> {

        try {
            const queueClient = await this.queueServiceClient.getQueueClient(this.queueName);

            // Ensure the queue is created
            await queueClient.create();

            const msg = Buffer.from(message, 'utf8').toString('base64');

            // Message visibility timeout
            if (visibilityTimeoutSeconds) {
                const dequeueSettings = {
                    visibilityTimeout: visibilityTimeoutSeconds
                };
                await queueClient.sendMessage(msg, dequeueSettings);
            }
            else {
                await queueClient.sendMessage(msg);
            }
        } catch (error) {
            const message = `Unable to send message to queue '${this.queueName}' with error: ${_getString(error)}`;
            this.logger.error(message);
            throw new StorageQueueError(message);
        }

    }
    
    /**
     * Send a message to retry VM polling after a delay
     */
    async scheduleVmPollRetry(message: VmCreationPollMessage, delaySeconds: number = 60): Promise<void> {
        try {
            this.logger.info(`Scheduling VM poll retry for: ${message.vmName} in ${delaySeconds} seconds`);
            
            // Update retry count
            const retryMessage = {
                ...message,
                retryCount: (message.retryCount || 0) + 1
            };
            
            const messageText = JSON.stringify(retryMessage);
            const encodedMessage = Buffer.from(messageText).toString('base64');
            
            // Send message - delay will be handled by the polling function
            const queueClient = await this.queueServiceClient.getQueueClient(this.queueName);
            await queueClient.sendMessage(encodedMessage);
            
            this.logger.info(`Scheduled VM poll retry for: ${message.vmName}, retry count: ${retryMessage.retryCount}`);
            
        } catch (error) {
            this.logger.error(`Failed to schedule VM poll retry for ${message.vmName}:`, error);
            throw error;
        }
    }
}


/**
 *
 * @param connectionString - Account connection string.
 * @param argument - property to get value from the connection string.
 * @returns Value of the property specified in argument.
 */
export function getValueInConnString(
    connectionString: string,
    argument:
        | "QueueEndpoint"
        | "AccountName"
        | "AccountKey"
        | "DefaultEndpointsProtocol"
        | "EndpointSuffix"
        | "SharedAccessSignature",
): string {
    const elements = connectionString.split(";");
    for (const element of elements) {
        if (element.trim().startsWith(argument)) {
            return element.trim().match(argument + "=(.*)")![1];
        }
    }
    return "";
}

/**
 *
 * @param connectionString - Account connection string.
 * @returns Value of the account name.
 */
export function getAccountNameFromConnString(connectionString: string): string {
    return getValueInConnString(connectionString, "AccountName");
}