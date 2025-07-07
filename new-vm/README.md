# Azure VM & Snapshot Recovery CLI

This repository provides a Bash script (`new-vm/create-vm-cli.sh`) to create new Azure Virtual Machines from existing snapshots. The script is designed for sysadmins and DevOps engineers who need to automate the creation of new VMs in Azure.

## Prerequisites

- Azure CLI (`az`)
- `jq` (for JSON processing)
- Bash (Linux/macOS)
- Sufficient Azure permissions to manage VMs, disks, and snapshots

## Setup

1. **Clone the repository** and navigate to the `new-vm` directory.

2. **Customize reference snapshots and T-shirt size mapping** in `reference.json` if needed:
    ```json
    {
      "S":   { "diskSku": "Standard_LRS",      "vmSize": "Standard_B2als_v2", "snapshotName": "s20250706T2230-test-01-75zhe_osdisk" },
      "M":   { "diskSku": "StandardSSD_LRS",   "vmSize": "Standard_B2als_v2", "snapshotName": "s20250706T2230-test-01-75zhe_osdisk" },
      "L":   { "diskSku": "StandardSSD_LRS",   "vmSize": "Standard_B2as_v2", "snapshotName": "s20250706T2230-test-01-75zhe_osdisk" },
      "XL":  { "diskSku": "Premium_LRS",       "vmSize": "Standard_D4as_v5", "snapshotName": "s20250706T2230-test-01-75zhe_osdisk" }
    }
    ```

3. **Ensure you are logged in to Azure CLI** and have the correct subscription set.

## Usage

Run the script with the desired operation and parameters:

```bash
cd new-vm
./create-vm-cli.sh --vm-name <VM_NAME> --resource-group <RESOURCE_GROUP> --tshirt-size <TSHIRT_SIZE> --subnet-id <SUBNET_ID>
```

Parameters:
- `--vm-name`: Name of the VM to be created.
- `--resource-group`: Resource group of the VM.
- `--tshirt-size`: T-shirt size for the new VM (e.g., S, M, L or XL) that also maps to the reference snapshot to use. You can customize these in the `reference.json` file.
- `--subnet-id`: Subnet ID for the new VM.

## Logging
The script uses structured logging with timestamps and log levels (INFO, WARN, ERROR). You can add more logging or enable debug output by extending the logging functions in the script.

## Troubleshooting
- Ensure you have the required Azure permissions.
- Make sure `jq` and `az` are installed and in your PATH.
- Check the log output for error messages.
