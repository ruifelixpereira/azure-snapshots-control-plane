#!/bin/bash

# The request body file
BODY_FILE="sample-alert.json"

# The Resource Graph endpoint
ENDPOINT="http://localhost:7071/api/alert"

curl -s -i -X POST "$ENDPOINT" \
    -H "Content-Type: application/json" \
    --data-binary "@$BODY_FILE"
