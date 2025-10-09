#!/bin/bash

# Debug script to check Function App logs for queue processing issues
# Usage: ./debug-queue-function.sh

# Configuration
FUNCTION_APP_NAME="your-function-app"         # Update this
RESOURCE_GROUP_NAME="your-resource-group"     # Update this

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${BLUE}🔍 Queue Function Debug Tool${NC}"
echo "============================"

# Check if logged in
if ! az account show >/dev/null 2>&1; then
    echo -e "${RED}❌ Not logged in to Azure CLI. Please run 'az login' first.${NC}"
    exit 1
fi

# Validate configuration
if [[ "$FUNCTION_APP_NAME" == "your-function-app" ]]; then
    echo -e "${RED}❌ Please update FUNCTION_APP_NAME in this script${NC}"
    exit 1
fi

if [[ "$RESOURCE_GROUP_NAME" == "your-resource-group" ]]; then
    echo -e "${RED}❌ Please update RESOURCE_GROUP_NAME in this script${NC}"
    exit 1
fi

echo -e "${BLUE}📱 Function App: $FUNCTION_APP_NAME${NC}"
echo -e "${BLUE}📁 Resource Group: $RESOURCE_GROUP_NAME${NC}"
echo ""

# Check Function App status
echo -e "${BLUE}🔍 Checking Function App status...${NC}"
STATUS=$(az functionapp show --name "$FUNCTION_APP_NAME" --resource-group "$RESOURCE_GROUP_NAME" --query "state" -o tsv 2>/dev/null)

if [[ "$STATUS" == "Running" ]]; then
    echo -e "${GREEN}✅ Function App is running${NC}"
else
    echo -e "${RED}❌ Function App status: $STATUS${NC}"
fi

# Check if logs are available
echo ""
echo -e "${BLUE}📊 Fetching recent logs (last 100 entries)...${NC}"
echo "================================================"

# Get logs using Azure CLI
az monitor log-analytics query \
    --workspace $(az functionapp show --name "$FUNCTION_APP_NAME" --resource-group "$RESOURCE_GROUP_NAME" --query "kind" -o tsv 2>/dev/null || echo "unknown") \
    --analytics-query "
        traces
        | where cloud_RoleName == '$FUNCTION_APP_NAME'
        | where timestamp > ago(1h)
        | order by timestamp desc
        | take 100
        | project timestamp, severityLevel, message
    " \
    --output table 2>/dev/null || {
    
    echo -e "${YELLOW}⚠️  Could not fetch structured logs. Trying alternative method...${NC}"
    echo ""
    
    # Alternative: Show recent function invocations
    echo -e "${BLUE}📋 Recent Function Invocations:${NC}"
    az functionapp log download \
        --name "$FUNCTION_APP_NAME" \
        --resource-group "$RESOURCE_GROUP_NAME" \
        --output-path "/tmp/function-logs.zip" 2>/dev/null || {
        
        echo -e "${YELLOW}⚠️  Could not download logs. Please check manually in Azure Portal.${NC}"
        echo ""
        echo -e "${BLUE}🌐 Azure Portal URLs:${NC}"
        echo "Function App: https://portal.azure.com/#@/resource/subscriptions/$(az account show --query 'id' -o tsv)/resourceGroups/$RESOURCE_GROUP_NAME/providers/Microsoft.Web/sites/$FUNCTION_APP_NAME"
        echo "Logs: https://portal.azure.com/#@/resource/subscriptions/$(az account show --query 'id' -o tsv)/resourceGroups/$RESOURCE_GROUP_NAME/providers/Microsoft.Web/sites/$FUNCTION_APP_NAME/logStream"
    }
}

echo ""
echo -e "${BLUE}🔍 Checking Storage Queue...${NC}"

# Check if queue exists and has messages
STORAGE_ACCOUNT=$(az functionapp config appsettings list --name "$FUNCTION_APP_NAME" --resource-group "$RESOURCE_GROUP_NAME" --query "[?name=='AzureWebJobsStorage'].value" -o tsv 2>/dev/null)

if [[ -n "$STORAGE_ACCOUNT" ]]; then
    # Extract storage account name from connection string
    STORAGE_NAME=$(echo "$STORAGE_ACCOUNT" | grep -o 'AccountName=[^;]*' | cut -d'=' -f2)
    
    if [[ -n "$STORAGE_NAME" ]]; then
        echo -e "${BLUE}📦 Storage Account: $STORAGE_NAME${NC}"
        
        # Check recovery-jobs queue
        echo -e "${BLUE}🔍 Checking recovery-jobs queue...${NC}"
        QUEUE_LENGTH=$(az storage queue metadata show --name "recovery-jobs" --account-name "$STORAGE_NAME" --auth-mode login --query "approximateMessageCount" -o tsv 2>/dev/null || echo "0")
        echo -e "${GREEN}📊 Messages in queue: $QUEUE_LENGTH${NC}"
        
        # Check poison queue
        echo -e "${BLUE}🔍 Checking poison queue...${NC}"
        POISON_LENGTH=$(az storage queue metadata show --name "recovery-jobs-poison" --account-name "$STORAGE_NAME" --auth-mode login --query "approximateMessageCount" -o tsv 2>/dev/null || echo "0")
        echo -e "${YELLOW}☠️  Messages in poison queue: $POISON_LENGTH${NC}"
        
        if [[ "$POISON_LENGTH" -gt "0" ]]; then
            echo ""
            echo -e "${RED}⚠️  There are messages in the poison queue!${NC}"
            echo -e "${YELLOW}💡 This indicates function failures. Check the logs above for errors.${NC}"
        fi
    else
        echo -e "${YELLOW}⚠️  Could not extract storage account name${NC}"
    fi
else
    echo -e "${YELLOW}⚠️  Could not get storage account connection string${NC}"
fi

echo ""
echo -e "${BLUE}🔧 Debugging Steps:${NC}"
echo "1. Check Function App logs in Azure Portal"
echo "2. Verify AzureWebJobsStorage connection string"
echo "3. Ensure function is deployed and running"
echo "4. Check RBAC permissions for storage account"
echo "5. Verify message format matches BatchOrchestratorInput interface"
echo ""
echo -e "${BLUE}📱 Quick Commands:${NC}"
echo "# Send test message:"
echo "./send-queue-message.sh examples/queue-message-dynamic-ip.json"
echo ""
echo "# Check function status:"
echo "az functionapp show --name '$FUNCTION_APP_NAME' --resource-group '$RESOURCE_GROUP_NAME' --query '{state:state, kind:kind}'"
echo ""
echo "# Stream logs:"
echo "az functionapp log tail --name '$FUNCTION_APP_NAME' --resource-group '$RESOURCE_GROUP_NAME'"