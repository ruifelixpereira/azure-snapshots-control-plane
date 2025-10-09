#!/bin/bash

# The request body file
BODY_FILE="request-body.json"

# The Resource Graph endpoint
ENDPOINT="https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01"

# Get the Azure access token
ACCESS_TOKEN=$(az account get-access-token --resource https://management.azure.com --query accessToken -o tsv)


# Loop to send 100 POST requests
for i in {1..20}; do
  curl -s -i -X POST "$ENDPOINT" \
    -H "Authorization: Bearer $ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    --data-binary "@$BODY_FILE"
done