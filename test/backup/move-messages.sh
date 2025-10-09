#!/usr/bin/env bash
# Move messages from a dead-letter storage queue to another queue using Azure CLI + jq.
# Usage:
#   ./requeue-deadletter.sh --src-queue dead-letter --dst-queue copy-control --connection-string "<conn>"
# OR
#   ./requeue-deadletter.sh --src-queue dead-letter --dst-queue copy-control --account-name <acct> --account-key <key>
#
# Options:
#   --batch N           Number of messages to fetch per request (default 32, max 32)
#   --sleep S           Seconds to sleep between batches (default 1)
#   --dry-run           Do not actually put/delete messages, just show what would happen
#   --help

set -euo pipefail

# Dependencies: az, jq
command -v az >/dev/null 2>&1 || { echo "az CLI required"; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "jq required"; exit 1; }

SRC_QUEUE=""
DST_QUEUE=""
CONN=""
ACCOUNT_NAME=""
ACCOUNT_KEY=""
BATCH=32
SLEEP=1
DRY_RUN=0

print_usage() {
  sed -n '1,120p' "$0" | sed -n '1,200p' >/dev/stderr
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --src-queue) SRC_QUEUE="$2"; shift 2;;
    --dst-queue) DST_QUEUE="$2"; shift 2;;
    --connection-string) CONN="$2"; shift 2;;
    --account-name) ACCOUNT_NAME="$2"; shift 2;;
    --account-key) ACCOUNT_KEY="$2"; shift 2;;
    --batch) BATCH="$2"; shift 2;;
    --sleep) SLEEP="$2"; shift 2;;
    --dry-run) DRY_RUN=1; shift ;;
    --help) print_usage; exit 0 ;;
    *) echo "Unknown parameter: $1"; print_usage; exit 1 ;;
  esac
done

if [[ -z "$SRC_QUEUE" || -z "$DST_QUEUE" ]]; then
  echo "Error: --src-queue and --dst-queue are required."
  print_usage
  exit 1
fi

# Build auth args
AUTH_ARGS=()
if [[ -n "$CONN" ]]; then
  AUTH_ARGS+=(--connection-string "$CONN")
else
  if [[ -z "$ACCOUNT_NAME" || -z "$ACCOUNT_KEY" ]]; then
    echo "Error: either --connection-string or both --account-name and --account-key must be provided."
    exit 1
  fi
  AUTH_ARGS+=(--account-name "$ACCOUNT_NAME" --account-key "$ACCOUNT_KEY")
fi

if (( BATCH < 1 )); then BATCH=1; fi
if (( BATCH > 32 )); then BATCH=32; fi

echo "Requeueing messages from '$SRC_QUEUE' -> '$DST_QUEUE' (batch=$BATCH, sleep=${SLEEP}s) dry-run=$DRY_RUN"

total_moved=0
iteration=0

while :; do
  iteration=$((iteration+1))
  echo "Batch #$iteration: fetching up to $BATCH messages from '$SRC_QUEUE'..."
  # Get messages (this makes them invisible for a short time)
  msgs_json=$(az storage message get --queue-name "$SRC_QUEUE" --num-of-messages "$BATCH" "${AUTH_ARGS[@]}" -o json 2>/dev/null || echo "[]")

  # If empty array -> done
  count=$(echo "$msgs_json" | jq 'length')
  if [[ "$count" -eq 0 ]]; then
    echo "No more messages found in '$SRC_QUEUE'."
    break
  fi

  echo "Fetched $count message(s)."

  echo "$msgs_json" | jq -c '.[]' | while read -r msg; do
    messageText=$(echo "$msg" | jq -r '.messageText')
    messageId=$(echo "$msg" | jq -r '.messageId')
    popReceipt=$(echo "$msg" | jq -r '.popReceipt')

    echo "----"
    echo "MessageId: $messageId"
    echo "PopReceipt: $popReceipt"
    echo "Message body (truncated 512 chars):"
    echo "${messageText:0:512}"
    echo "----"

    if [[ "$DRY_RUN" -eq 1 ]]; then
      echo "[dry-run] would put message into '$DST_QUEUE' and delete from '$SRC_QUEUE'."
      continue
    fi

    # Put message into destination queue
    echo "Putting message into '$DST_QUEUE'..."
    az storage message put --queue-name "$DST_QUEUE" --content "$messageText" "${AUTH_ARGS[@]}" >/dev/null

    # After successful put, delete the message from source queue using messageId + popReceipt
    echo "Deleting message $messageId from '$SRC_QUEUE'..."
    az storage message delete --queue-name "$SRC_QUEUE" --message-id "$messageId" --pop-receipt "$popReceipt" "${AUTH_ARGS[@]}" >/dev/null

    total_moved=$((total_moved+1))
    echo "Moved messageId $messageId -> $DST_QUEUE"
  done

  echo "Batch #$iteration completed. Total moved so far: $total_moved"
  sleep "$SLEEP"
done

echo "Done. Total moved: $total_moved"
exit 0