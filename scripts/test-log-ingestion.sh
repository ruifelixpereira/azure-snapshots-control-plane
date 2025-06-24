#!/bin/bash

# Set these variables according to your deployment
DCE_ENDPOINT="https://snmsnapmng-dce01-bjmo.northeurope-1.ingest.monitor.azure.com"
#DCR_IMMUTABLE_ID="<your-dcr-immutable-id>"
DCR_IMMUTABLE_ID="$(az monitor data-collection rule show --name snmsnapmng-dcr01 --resource-group snapshots-management --query "immutableId" --output tsv)"

API_VERSION="2023-01-01"
LOG_STREAM="Custom-SnapshotsOperations_CL"
#AUTH_TOKEN="<your-azure-auth-token>"
AUTH_TOKEN="$(az account get-access-token --resource https://monitor.azure.com --query accessToken --output tsv)"



# Example log payload
cat > payload.json <<EOF
[
  {
    "TimeGenerated": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
    "Message": "Test log from curl"
  }
]
EOF

curl -X POST "$DCE_ENDPOINT/dataCollectionRules/$DCR_IMMUTABLE_ID/streams/$LOG_STREAM?api-version=$API_VERSION" \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @payload.json

# Clean up
rm payload.json