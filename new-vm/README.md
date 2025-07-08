# Azure VM Creation from Snapshots CLI

This repository provides a Bash script (`new-vm/create-vm-cli.sh`) to create new Azure Virtual Machines from existing snapshots. The script is designed for sysadmins and DevOps engineers who need to automate the creation of new VMs in Azure.

## Prerequisites

- Azure CLI (`az`)
- `jq` (for JSON processing)
- Bash (Linux/macOS)
- Sufficient Azure permissions to manage VMs, disks, and snapshots

## Setup

1. **Clone the repository** and navigate to the `new-vm` directory.

2. **Ensure you are logged in to Azure CLI** and have the correct subscription set.

## Usage

Run the script with the desired operation and parameters:

```bash
cd new-vm
./create-vm-cli.sh --new-vm-name <NEW_VM_NAME> --resource-group <RESOURCE_GROUP> --original-vm-name <ORIGINAL_VM_NAME> --new-ip <NEW_IP>
```

Parameters:
- `--new-vm-name`: Name of the VM to be created.
- `--resource-group`: Resource group of the VM.
- `--original-vm-name`: Name of the original VM that is used to create a snapshot, get the size, sku and location.
- `--new-ip`: New static IP address for the VM, that will be in the same subnet of the original VM.

## Logging
The script uses structured logging with timestamps and log levels (INFO, WARN, ERROR). You can add more logging or enable debug output by extending the logging functions in the script.

## Troubleshooting
- Ensure you have the required Azure permissions.
- Make sure `jq` and `az` are installed and in your PATH.
- Check the log output for error messages.
