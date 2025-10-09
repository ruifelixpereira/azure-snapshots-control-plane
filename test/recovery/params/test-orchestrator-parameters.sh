#!/bin/bash

# Test script for orchestrator parameters
# This script shows different ways to call your orchestrator with parameters

BASE_URL="http://localhost:7071/api/orchestrators"
ORCHESTRATOR_NAME="batchOrchestrator"

echo "🚀 Testing Orchestrator Parameters"
echo "=================================="

# Test 1: Basic parameters
echo -e "\n📋 Test 1: Basic Parameters"
curl -X POST "${BASE_URL}/${ORCHESTRATOR_NAME}" \
  -H "Content-Type: application/json" \
  -d '{
    "batchSize": 5,
    "regions": ["eastus"],
    "maxVMs": 20
  }' \
  | jq '.'

echo -e "\n⏳ Waiting 2 seconds...\n"
sleep 2

# Test 2: Advanced parameters with all options
echo -e "\n📋 Test 2: Advanced Parameters"
curl -X POST "${BASE_URL}/${ORCHESTRATOR_NAME}" \
  -H "Content-Type: application/json" \
  -d '{
    "batchSize": 10,
    "regions": ["eastus", "westus"],
    "maxVMs": 50,
    "vmNamePrefix": "test-vm",
    "vmSize": "Standard_B2s",
    "resourceGroup": "test-rg",
    "delayBetweenBatches": 5,
    "filters": {
      "environment": "test",
      "purpose": "demo"
    }
  }' \
  | jq '.'

echo -e "\n⏳ Waiting 2 seconds...\n"
sleep 2

# Test 3: Minimal parameters (using defaults)
echo -e "\n📋 Test 3: Minimal Parameters (Defaults)"
curl -X POST "${BASE_URL}/${ORCHESTRATOR_NAME}" \
  -H "Content-Type: application/json" \
  -d '{}' \
  | jq '.'

echo -e "\n⏳ Waiting 2 seconds...\n"
sleep 2

# Test 4: Production-like parameters
echo -e "\n📋 Test 4: Production-like Parameters"
curl -X POST "${BASE_URL}/${ORCHESTRATOR_NAME}" \
  -H "Content-Type: application/json" \
  -d '{
    "batchSize": 20,
    "regions": ["eastus", "westus", "eastus2"],
    "maxVMs": 200,
    "vmNamePrefix": "prod-recovery",
    "vmSize": "Standard_D2s_v3",
    "resourceGroup": "production-rg",
    "delayBetweenBatches": 15,
    "filters": {
      "environment": "production",
      "tier": "critical",
      "backupRequired": true
    }
  }' \
  | jq '.'

echo -e "\n✅ All tests completed!"
echo -e "\n💡 Tips:"
echo "- Check the orchestrator logs to see how parameters are processed"
echo "- Use the status URLs returned to monitor orchestrator progress"
echo "- Modify the parameters above to test different scenarios"