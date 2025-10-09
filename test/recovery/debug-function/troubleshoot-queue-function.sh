#!/bin/bash

# Comprehensive troubleshooting script for Azure Functions queue trigger
# Usage: ./troubleshoot-queue-function.sh

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
MAGENTA='\033[0;35m'
NC='\033[0m' # No Color

echo -e "${BLUE}🔧 Azure Functions Queue Trigger Troubleshooting${NC}"
echo "=================================================="
echo ""

# Check if we're in the right directory
if [ ! -f "package.json" ]; then
    echo -e "${RED}❌ Please run this script from the function app root directory${NC}"
    exit 1
fi

echo -e "${BLUE}1. 📦 Checking Project Structure${NC}"
echo "--------------------------------"

# Check for essential files
files_to_check=(
    "src/functions/queuestart.ts"
    "package.json"
    "tsconfig.json"
    "host.json"
    "local.settings.json"
)

for file in "${files_to_check[@]}"; do
    if [ -f "$file" ]; then
        echo -e "${GREEN}✅ $file exists${NC}"
    else
        echo -e "${RED}❌ $file missing${NC}"
    fi
done

echo ""
echo -e "${BLUE}2. 🏗️ Building Project${NC}"
echo "----------------------"

if npm run build; then
    echo -e "${GREEN}✅ Build successful${NC}"
else
    echo -e "${RED}❌ Build failed - check TypeScript errors${NC}"
    exit 1
fi

echo ""
echo -e "${BLUE}3. 📄 Checking host.json Configuration${NC}"
echo "-------------------------------------"

if [ -f "host.json" ]; then
    echo "Current host.json:"
    cat host.json
    echo ""
    
    # Check if extensions are loaded
    if grep -q "Microsoft.Azure.WebJobs.Extensions.Storage" host.json 2>/dev/null; then
        echo -e "${GREEN}✅ Storage extension configured${NC}"
    else
        echo -e "${YELLOW}⚠️  Storage extension not explicitly configured${NC}"
    fi
else
    echo -e "${RED}❌ host.json not found${NC}"
fi

echo ""
echo -e "${BLUE}4. 🔍 Checking Function Registration${NC}"
echo "-----------------------------------"

# Check if the compiled function exists
if [ -f "dist/src/functions/queuestart.js" ]; then
    echo -e "${GREEN}✅ Compiled queuestart.js exists${NC}"
    
    # Check if function is properly registered
    if grep -q "app.storageQueue" dist/src/functions/queuestart.js; then
        echo -e "${GREEN}✅ Queue trigger registration found in compiled code${NC}"
    else
        echo -e "${RED}❌ Queue trigger registration not found in compiled code${NC}"
    fi
else
    echo -e "${RED}❌ Compiled queuestart.js not found${NC}"
fi

echo ""
echo -e "${BLUE}5. 🏃 Testing Local Function Runtime${NC}"
echo "----------------------------------"

# Check if func CLI is available
if command -v func &> /dev/null; then
    echo -e "${GREEN}✅ Azure Functions Core Tools available${NC}"
    
    # Start functions in background for testing
    echo "Starting function runtime..."
    timeout 10s func start --verbose 2>&1 | head -20 || {
        echo -e "${YELLOW}⚠️  Function runtime test completed${NC}"
    }
else
    echo -e "${RED}❌ Azure Functions Core Tools not found${NC}"
    echo "Install with: npm install -g azure-functions-core-tools@4"
fi

echo ""
echo -e "${BLUE}6. 🔐 Checking Storage Configuration${NC}"
echo "-----------------------------------"

if [ -f "local.settings.json" ]; then
    # Check if AzureWebJobsStorage is configured
    if grep -q "AzureWebJobsStorage" local.settings.json; then
        echo -e "${GREEN}✅ AzureWebJobsStorage configured${NC}"
        
        # Extract storage account name (if possible)
        storage_config=$(grep "AzureWebJobsStorage" local.settings.json | cut -d'"' -f4)
        if [[ "$storage_config" == *"AccountName="* ]]; then
            account_name=$(echo "$storage_config" | grep -o 'AccountName=[^;]*' | cut -d'=' -f2)
            echo -e "${BLUE}📦 Storage Account: $account_name${NC}"
        fi
    else
        echo -e "${RED}❌ AzureWebJobsStorage not configured${NC}"
    fi
else
    echo -e "${RED}❌ local.settings.json not found${NC}"
fi

echo ""
echo -e "${BLUE}7. 📊 Checking Queue Status${NC}"
echo "---------------------------"

# Try to check queue status if storage is configured
if [ -f "local.settings.json" ] && grep -q "AzureWebJobsStorage" local.settings.json; then
    storage_config=$(grep "AzureWebJobsStorage" local.settings.json | cut -d'"' -f4)
    
    if [[ "$storage_config" == *"AccountName="* ]]; then
        account_name=$(echo "$storage_config" | grep -o 'AccountName=[^;]*' | cut -d'=' -f2)
        
        echo "Checking queue 'recovery-jobs'..."
        if az storage queue list --account-name "$account_name" --auth-mode login --output table 2>/dev/null | grep -q "recovery-jobs"; then
            echo -e "${GREEN}✅ Queue 'recovery-jobs' exists${NC}"
            
            # Check message count
            msg_count=$(az storage queue metadata show --name "recovery-jobs" --account-name "$account_name" --auth-mode login --query "approximateMessageCount" -o tsv 2>/dev/null || echo "0")
            echo -e "${BLUE}📊 Messages in queue: $msg_count${NC}"
            
            # Check poison queue
            poison_count=$(az storage queue metadata show --name "recovery-jobs-poison" --account-name "$account_name" --auth-mode login --query "approximateMessageCount" -o tsv 2>/dev/null || echo "0")
            echo -e "${YELLOW}☠️  Messages in poison queue: $poison_count${NC}"
        else
            echo -e "${YELLOW}⚠️  Queue 'recovery-jobs' not found (will be created automatically)${NC}"
        fi
    fi
fi

echo ""
echo -e "${MAGENTA}📋 TROUBLESHOOTING SUMMARY${NC}"
echo "=========================="
echo ""

echo -e "${BLUE}🔧 Common Issues and Solutions:${NC}"
echo ""

echo -e "${YELLOW}Issue 1: Function not registered properly${NC}"
echo "Solution: Ensure queuestart.ts exports the function correctly"
echo "Check: dist/src/functions/queuestart.js should contain app.storageQueue() call"
echo ""

echo -e "${YELLOW}Issue 2: Storage connection issues${NC}"
echo "Solution: Verify AzureWebJobsStorage connection string"
echo "Check: local.settings.json or Azure Function App configuration"
echo ""

echo -e "${YELLOW}Issue 3: Function runtime not loading function${NC}"
echo "Solution: Check func start output for errors"
echo "Check: TypeScript compilation and function registration"
echo ""

echo -e "${YELLOW}Issue 4: Queue trigger extension not loaded${NC}"
echo "Solution: Ensure Microsoft.Azure.WebJobs.Extensions.Storage is available"
echo "Check: Run npm install to ensure all dependencies"
echo ""

echo -e "${BLUE}🎯 Next Steps:${NC}"
echo "1. Fix any issues identified above"
echo "2. Run: npm run build"
echo "3. Run: func start --verbose"
echo "4. Look for queueStart function in startup logs"
echo "5. Send test message: ./send-queue-message.sh examples/queue-message-dynamic-ip.json"
echo "6. Check logs for function invocation"
echo ""

echo -e "${BLUE}🔍 Manual Verification Commands:${NC}"
echo ""
echo "# Check compiled function:"
echo "cat dist/src/functions/queuestart.js | grep -A 5 -B 5 'storageQueue'"
echo ""
echo "# Test function runtime:"
echo "func start --verbose 2>&1 | grep -i queue"
echo ""
echo "# Check storage connection:"
echo "func azure functionapp fetch-app-settings <your-function-app-name>"