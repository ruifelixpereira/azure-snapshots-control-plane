import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import packageJson from "../../package.json";

interface HealthResponse {
    success: boolean;
    message: string;
    version: string;
}

export async function health(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    
        return {
            status: 200,
            body: JSON.stringify({
                success: true,
                version: packageJson.version,
                message: `Application version ${packageJson.version} is healthy`
            } as HealthResponse)
        };
}

app.http('health', {
    methods: ['GET'],
    authLevel: 'function',
    handler: health
});
