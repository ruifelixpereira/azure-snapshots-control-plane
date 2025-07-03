# Azure VM & Snapshot Recovery CLI

This repository provides a Bash script (`recovery/recover-cli.sh`) to manage Azure Virtual Machines and their snapshots, supporting restore and automation scenarios. The script is designed for sysadmins and DevOps engineers who need to automate VM recovery, snapshot management, and batch operations in Azure.

## Features

- **List All VMs**: Show all VMs and their backup protection state.
- **List Protected VMs**: Show only VMs with active backup tags.
- **List Snapshots**: List all snapshots for a specific VM.
- **Export Metadata**: Export VM and snapshot metadata to a JSON file.
- **Create VM from Snapshot**: Restore a VM from a specific snapshot.
- **Restore VM**: Restore a VM from the most recent snapshot.
- **Restore VM Group**: Restore a group of VMs from their most recent snapshots.
- **Restore All VMs**: Restore all VMs from their most recent snapshots.
- **Custom T-shirt Size Mapping**: Map T-shirt sizes to disk SKUs and VM sizes using a customizable JSON file (`tshirt-map.json`).
- **Parallel Operations**: Batch VM restores run in parallel for efficiency.
- **Structured Logging**: Consistent log output with timestamps and log levels.

## Prerequisites

- Azure CLI (`az`)
- `jq` (for JSON processing)
- Bash (Linux/macOS)
- Sufficient Azure permissions to manage VMs, disks, and snapshots

## Setup

1. **Clone the repository** and navigate to the `recovery` directory.
2. **Customize T-shirt size mapping** in `tshirt-map.json` if needed:
    ```json
    {
      "S":   { "diskSku": "Standard_LRS",      "vmSize": "Standard_B2als_v2" },
      "M":   { "diskSku": "StandardSSD_LRS",   "vmSize": "Standard_B2als_v2" },
      "L":   { "diskSku": "StandardSSD_LRS",   "vmSize": "Standard_B2as_v2" },
      "XL":  { "diskSku": "Premium_LRS",       "vmSize": "Standard_D4as_v5" }
    }
    ```
3. **Ensure you are logged in to Azure CLI** and have the correct subscription set.

## Usage

Run the script with the desired operation and parameters:

```bash
cd recovery
./recover-cli.sh --operation <operation> [parameters]
```

### Main Operations

- **List all VMs:**
    ```bash
    ./recover-cli.sh --operation list-all-vms
    ```

- **List protected VMs:**
    ```bash
    ./recover-cli.sh --operation list-protected-vms
    ```

- **List snapshots for a VM:**
    ```bash
    ./recover-cli.sh --operation list-vm-snapshots --vm-name <VM_NAME> --resource-group <RESOURCE_GROUP>
    ```

    Parameters:
    - `--vm-name`: Name of the VM for which we want to list the existing snapshots.
    - `--resource-group`: Resource group of the VM.

- **Export metadata:**
    ```bash
    ./recover-cli.sh --operation export-metadata [--custom-metadata-file <CUSTOM_METADATA_FILE>]
    ```

    Parameters:
    - `--custom-metadata-file`: Name of the custom metadata file to where the export is written.

- **Create VM from snapshot:**
    ```bash
    ./recover-cli.sh --operation create-vm --vm-name <VM_NAME> --resource-group <RESOURCE_GROUP> --snapshot-name <SNAPSHOT_NAME> --tshirt-size <TSHIRT_SIZE> --subnet-id <SUBNET_ID>
    ```

    Parameters:
    - `--vm-name`: Name of the VM to be created.
    - `--resource-group`: Resource group of the VM.
    - `--snapshot-name`: Name of the snapshot to use.
    - `--tshirt-size`: T-shirt size for the new VM (e.g., S, M, L or XL).
    - `--subnet-id`: Subnet ID for the new VM.

- **Restore VM:**
    ```bash
    ./recover-cli.sh --operation restore-vm --original-vm-name <ORIGINAL_VM_NAME> --resource-group <RESOURCE_GROUP> --subnet-id <SUBNET_ID> [--restore-primary-region] [--custom-metadata-file <CUSTOM_METADATA_FILE>]
    ```

    Parameters:
    - `--original-vm-name`: Name of the original VM to get the available snapshots. By default, the most recent snapshot is used to create the new recovered VM. If you want to specify a different snapshot, you can use a custom metadata file (passing the parameter `--custom-metadata-file`) to specify a specific snapshot.
    - `--resource-group`: Resource group of the VM.
    - `--subnet-id`: Subnet ID for the new VM.
    - `--restore-primary-region`: Optional parameter to define that the restore should use the most recent snapshot (or the one specified in the custom metadata file) in the primary region. If not specified, the new VM is created in the secondary region (used for failover), with a snapshot also in the secondary region.
    - `--custom-metadata-file`: Name of the custom metadata file that can be used to specifiy the snaphshot to create the new VM. This file can be exported using the `export-metadata` command.

- **Restore group of VMs:**
    ```bash
    ./recover-cli.sh --operation restore-vm-group --original-vm-group "vm1,vm2,vm3" --resource-group <RESOURCE_GROUP> --subnet-id <SUBNET_ID> [--restore-primary-region] [--custom-metadata-file <CUSTOM_METADATA_FILE>]
    ```

    Parameters:
    - `--original-vm-group`: Comma-separated list of original VM names to get the available snapshots. By default, the most recent snapshot is used to create the new recovered VMs. If you want to specify a different snapshot, you can use a custom metadata file (passing the parameter `--custom-metadata-file`) to specify a specific snapshot.
    - `--resource-group`: Resource group of the VMs.
    - `--subnet-id`: Subnet ID for the new VMs.
    - `--restore-primary-region`: Optional parameter to define that the restore should use the most recent snapshots (or the ones specified in the custom metadata file) in the primary region. If not specified, the new VMs are created in the secondary region (used for failover), with a snapshot also in the secondary region.
    - `--custom-metadata-file`: Name of the custom metadata file that can be used to specifiy the snaphshots to create the new VMs. This file can be exported using the `export-metadata` command.

- **Restore all VMs:**
    ```bash
    ./recover-cli.sh --operation restore-all-vms --subnet-id <SUBNET_ID> [--restore-primary-region] [--custom-metadata-file <CUSTOM_METADATA_FILE>]
    ```
    Parameters:
    - `--subnet-id`: Subnet ID for the new VMs.
    - `--restore-primary-region`: Optional parameter to define that the restore should use the most recent snapshots (or the ones specified in the custom metadata file) in the primary region. If not specified, the new VMs are created in the secondary region (used for failover), with a snapshot also in the secondary region.
    - `--custom-metadata-file`: Name of the custom metadata file that can be used to specifiy the snaphshots to create the new VMs. This file can be exported using the `export-metadata` command.

- **Help:**
    ```bash
    ./recover-cli.sh --help
    ```

## Customization

### T-shirt Size Mapping
Edit `tshirt-map.json` to change how T-shirt sizes map to Azure disk SKUs and VM sizes.

This is an example of the custom metadata file:

```json
{
  "S":   { "diskSku": "Standard_LRS",      "vmSize": "Standard_B2als_v2" },
  "M":   { "diskSku": "StandardSSD_LRS",   "vmSize": "Standard_B2als_v2" },
  "L":   { "diskSku": "StandardSSD_LRS",   "vmSize": "Standard_B2as_v2" },
  "XL":  { "diskSku": "Premium_LRS",       "vmSize": "Standard_D4as_v5" }
}
```

### Metadata File
By default, metadata is stored in `recovery-metadata.json`. Use `--custom-metadata-file` to specify a different file.

This is an example of the custom metadata file:

```json
[
  {
    "vmName": "vm1",
    "resourceGroup": "snapshots-management",
    "vmSize": "Standard_B2als_v2",
    "diskSku": "StandardSSD_LRS",
    "diskSizeGB": "30",
    "lastTemporarySnapshot": {
      "location": "northeurope",
      "name": "s20250701T2230-test-for-cloning_OsDisk_1_bd47a1e4d67b48ce907309f46a3034b8",
      "resourceGroup": "snapshots-management"
    },
    "lastBackupSnapshot": {
      "location": "westeurope",
      "name": "s20250701T2230-test-for-cloning_OsDisk_1_bd47a1e4d67b48ce907309f46a3034b8-sec",
      "resourceGroup": "snapshots-management"
    },
    "snapshots": [
      {
        "location": "westeurope",
        "name": "s20250627T2231-test-for-cloning_OsDisk_1_bd47a1e4d67b48ce907309f46a3034b8-sec",
        "resourceGroup": "snapshots-management"
      },
      {
        "location": "westeurope",
        "name": "s20250628T2230-test-for-cloning_OsDisk_1_bd47a1e4d67b48ce907309f46a3034b8-sec",
        "resourceGroup": "snapshots-management"
      },
      {
        "location": "westeurope",
        "name": "s20250629T2230-test-for-cloning_OsDisk_1_bd47a1e4d67b48ce907309f46a3034b8-sec",
        "resourceGroup": "snapshots-management"
      },
      {
        "location": "westeurope",
        "name": "s20250630T2230-test-for-cloning_OsDisk_1_bd47a1e4d67b48ce907309f46a3034b8-sec",
        "resourceGroup": "snapshots-management"
      },
      {
        "location": "westeurope",
        "name": "s20250701T2230-test-for-cloning_OsDisk_1_bd47a1e4d67b48ce907309f46a3034b8-sec",
        "resourceGroup": "snapshots-management"
      },
      {
        "location": "northeurope",
        "name": "s20250701T2230-test-for-cloning_OsDisk_1_bd47a1e4d67b48ce907309f46a3034b8",
        "resourceGroup": "snapshots-management"
      }
    ]
  },
  {
    "vmName": "vm2",
    "resourceGroup": "snapshots-management",
    "vmSize": "Standard_B2als_v2",
    "diskSku": "StandardSSD_LRS",
    "diskSizeGB": "30",
    "lastTemporarySnapshot": {
      "location": "westeurope",
      "name": "s20250702T2231-test-01-75zhe_osdisk",
      "resourceGroup": "snapshots-management"
    },
    "lastBackupSnapshot": {
      "location": "westeurope",
      "name": "s20250702T2231-test-01-75zhe_osdisk-sec",
      "resourceGroup": "snapshots-management"
    },
    "snapshots": [
      {
        "location": "westeurope",
        "name": "s20250702T2231-test-01-75zhe_osdisk",
        "resourceGroup": "snapshots-management"
      },
      {
        "location": "westeurope",
        "name": "s20250702T2231-test-01-75zhe_osdisk-sec",
        "resourceGroup": "snapshots-management"
      }
    ]
  }
]
```

## Logging
The script uses structured logging with timestamps and log levels (INFO, WARN, ERROR). You can add more logging or enable debug output by extending the logging functions in the script.

## Parallelism
When restoring multiple VMs, the script launches each restore as a background process and waits for all to finish, maximizing efficiency.

## Troubleshooting
- Ensure you have the required Azure permissions.
- Make sure `jq` and `az` are installed and in your PATH.
- Check the log output for error messages.

