#!/usr/bin/env bash
set -euo pipefail

# -------------------------------------------
# List VM names attached to a specific subnet using Azure Resource Graph
# Outputs a single line JSON array string: ["vm1","vm2",...]
#
# Usage:
#   ./list-vms-in-subnet.sh "<subnet_resource_id>"
# -------------------------------------------

# Check if subnet ID was provided
if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <subnet_resource_id>"
  echo "Example:"
  echo "  $0 \"/subscriptions/<subId>/resourceGroups/<rgName>/providers/Microsoft.Network/virtualNetworks/<vnetName>/subnets/<subnetName>\""
  exit 1
fi

SUBNET_ID="$1"

# Validate input
if [[ -z "${SUBNET_ID// }" ]]; then
  echo "Error: Subnet resource ID cannot be empty."
  exit 1
fi

# Ensure prerequisites
command -v az >/dev/null 2>&1 || { echo "Error: Azure CLI (az) not found."; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "Error: jq not found."; exit 1; }

# Build the KQL query
KQL="resources
| where type =~ 'microsoft.network/networkinterfaces'
| mv-expand ipconfig = properties.ipConfigurations
| extend nicId = id
       , vmId = tolower(tostring(properties.virtualMachine.id))
       , subnetId = tolower(tostring(ipconfig.properties.subnet.id))
| where isnotempty(vmId) and isnotempty(subnetId)
| where subnetId == tolower('__SUBNET_ID__')
| project nicId, vmId
| join kind=inner (
    resources
    | where type =~ 'microsoft.compute/virtualmachines'
    | project vmId = tolower(id),
              vmName = name,
              vmResourceGroup = resourceGroup,
              vmLocation = location,
              subscriptionId,
              osType = tostring(properties.storageProfile.osDisk.osType),
              powerState = tostring(properties.extended.instanceView.powerState.code)
) on vmId
| project vmName
| order by vmName asc"

QUERY=$(echo "$KQL" | sed "s/__SUBNET_ID__/$(echo "$SUBNET_ID" | sed 's/[\/&]/\\&/g')/g")

RESULT_NAMES=()
SKIP_TOKEN=""
PAGE_SIZE=1000

while :; do
  if [[ -n "$SKIP_TOKEN" ]]; then
    RESP=$(az graph query \
      --graph-query "$QUERY" \
      --first $PAGE_SIZE \
      --skip-token "$SKIP_TOKEN" \
      -o json)
  else
    RESP=$(az graph query \
      --graph-query "$QUERY" \
      --first $PAGE_SIZE \
      -o json)
  fi

  PAGE_NAMES=($(echo "$RESP" | jq -r '.data // [] | .[].vmName' | tr -d '\r'))
  if (( ${#PAGE_NAMES[@]} )); then
    RESULT_NAMES+=("${PAGE_NAMES[@]}")
  fi

  NEW_TOKEN=$(echo "$RESP" | jq -r '.skipToken // empty')
  if [[ -z "$NEW_TOKEN" ]]; then
    break
  fi
  SKIP_TOKEN="$NEW_TOKEN"
done

jq -rn --argjson arr "$(printf '%s\n' "${RESULT_NAMES[@]}" | jq -R . | jq -s .)" '$arr | @json'
