# Azure VM & Snapshot Recovery CLI

This repository provides a Bash script (`recovery-cli/recover-cli.sh`) to recover Azure Virtual Machines from snapshots, supporting restore and automation scenarios. The script is designed for sysadmins and DevOps engineers who need to automate VM recovery, snapshot management, and batch operations in Azure.

## Features

- **List Most Recent Snapshots**: List the most recent snapshots for all VMs.
- **List VM Snapshots**: List all available snapshots for a specific VM.
- **Restore VMs**: Restores one VM, a list of VMs or all VMs in a target resource group and subnet.
- **Create Sample Data File**: Creates a sample data file used to configure the Restore VMs operation.
- **Parallel Operations**: All VMs in a batch are restored in parallel.
- **Recovery Monitoring**: All recovery operations are logged in Log Analytics and an Azure Monitoring Workbook is provided, allowing to track progress.

## Prerequisites

- Azure CLI (`az`)
- `jq` (for JSON processing)
- Bash (Linux/macOS)
- Sufficient Azure permissions to manage VMs, disks, and snapshots

## Setup

1. **Clone the repository** and navigate to the `recovery-cli` directory.
2. **Ensure you are logged in to Azure CLI** and have the correct subscription set.

## Usage

Run the script with the desired operation and parameters:

```bash
cd recovery
./recover-cli.sh --operation <operation> [parameters]
```

### Main Operations

- **List most recent snapshots available for all VMs:**
    ```bash
    ./recover-cli.sh --operation list-most-recent-snapshots
    ```

- **List all available snapshots for a VM:**
    ```bash
    ./recover-cli.sh --operation list-vm-snapshots --vm-name <VM_NAME> --resource-group <RESOURCE_GROUP>
    ```

    Parameters:
    - `--vm-name`: Name of the VM for which we want to list the existing snapshots.
    - `--resource-group`: Resource group of the VM.

- **Restore VMs (single VM, list of VMs or all VMs):**
    ```bash
    ./recover-cli.sh --operation restore-vms --storage-account <STORAGE_ACCOUNT_NAME> --data <DATA_FILE>
    ```

    Parameters:
    - `--storage-account`: The recovery process is triggered by a storage queue. This is the name of the storage account used by the Snapshots Recovery Control Plane.
    - `--data`: The json data file that contains the configuration details for the recovery process. Check the details of this data file [below](#recovery-data-file).

- **Create sample data file for restoring:**
    ```bash
    ./recover-cli.sh --operation create-sample-data-file
    ```

- **Help:**
    ```bash
    ./recover-cli.sh --help
    ```

## Recovery Data File

The recovery JSON data file used to trigger a recovery process for single, multiple or all VMs includes the following fields:

- `targetSubnetIds`: The list of target subnets where the recovered VMs will be created.
- `targetResourceGroup`: The target resource group where the recovered VMs will be created.
- `maxTimeGenerated`: The maximum time for the snapshots to be considered for recovery.
- `useOriginalIpAddress`: Value `true` or `false` depending if you want the restored VM to keep the original IP address.
- `waitForVmCreationCompletion`: Value `true` or `false` depending if you want the script to wait for the VM creation to complete before proceeding.
- `appendUniqueStringToVmName`: Value `true` or `false` depending if you want to append a unique string to the VM name during recovery.
- `vmFilter`: Optional filter to specify which VMs to recover. This can be a list of VM names. If omitted, all VMs for which there is a snapshot will be recovered.

This is an example of the custom metadata file:

```json
{
    "targetSubnetIds": [
        "/subscriptions/xxx-xxx-xxx-xxx/resourceGroups/recovery-rg/providers/Microsoft.Network/virtualNetworks/recovery-vnet/subnets/default"
    ],
    "targetResourceGroup": "recovery-snap-rg",
    "maxTimeGenerated": "2025-09-27T10:30:00.000Z",
    "useOriginalIpAddress": true,
    "waitForVmCreationCompletion": false,
    "appendUniqueStringToVmName": false,
    "vmFilter": [
        "vm-01",
        "vm-02"
    ]
}
```

You can use this command to generate a sample data file:

```bash
./recover-cli.sh --operation create-sample-data-file
```

## Logging
The script uses structured logging with timestamps and log levels (INFO, WARN, ERROR). You can add more logging or enable debug output by extending the logging functions in the script.

## Parallelism
When restoring multiple VMs, the script launches each restore as a background process and waits for all to finish, maximizing efficiency.

## Troubleshooting
- Ensure you have the required Azure permissions.
- Make sure `jq` and `az` are installed and in your PATH.
- Check the log output for error messages.


## Test Examples

```bash
./recover-cli.sh --operation list-most-recent-snapshots

./recover-cli.sh --operation list-vm-snapshots --vm-name scale-test-vm-001 --resource-group scale-test-rg

./recover-cli.sh --operation create-sample-data-file

./recover-cli.sh --operation restore-vms --storage-account snmjsnaprecsa01 --data sample-recovery-data.json

./recover-cli.sh --operation restore-vms --storage-account snmjsnaprecsa01 --data test-01-recover-single-vm.json

./recover-cli.sh --operation restore-vms --storage-account snmjsnaprecsa01 --data test-02-recover-all-vms-nowait.json

./recover-cli.sh --operation restore-vms --storage-account smcpsnapmngsa01 --data test-03-recover-all-vms-nowait-anyip.json
```
