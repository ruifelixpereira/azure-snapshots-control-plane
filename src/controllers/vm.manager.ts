// Disk snapshots
import { ILogger } from '../common/logger';
import { ComputeManagementClient } from "@azure/arm-compute";
import { NetworkManagementClient } from "@azure/arm-network";
import { DefaultAzureCredential } from "@azure/identity";
import { VmError, _getString } from "../common/apperror";
import { NewVmDetails, VmDisk, VmNic, VmInfo, TrackingInfo, VmCreationResult, VmCreationPollMessage } from '../common/interfaces';
import { formatDateYYYYMMDDTHHMM } from '../common/utils';

 
export class VmManager {

    private computeClient: ComputeManagementClient;
    private networkClient: NetworkManagementClient;

    constructor(private logger: ILogger, subscriptionId: string) {
        const credential = new DefaultAzureCredential();
        this.computeClient = new ComputeManagementClient(credential, subscriptionId);
        this.networkClient = new NetworkManagementClient(credential, subscriptionId);
    }

    public async createDiskFromSnapshot(source: NewVmDetails, jobId: string): Promise<VmDisk> {

        try {
            let newDisk: VmDisk = null;
            let diskExists = false;
            const diskName = `${source.sourceSnapshot.vmName}-${source.sourceSnapshot.diskProfile}-${formatDateYYYYMMDDTHHMM(new Date())}`;

            // Add mandatory tags from environment variable
            let allTags = {};
            const mandatoryTags = JSON.parse(process.env.SMCP_MANDATORY_TAGS || "[]");
            for (const tag of mandatoryTags) {
                if (tag.key && tag.value) {
                    allTags[tag.key] = tag.value;
                }
            }

            // Tracking Id
            const tracking: TrackingInfo = {
                batchId: source.batchId,
                jobId: jobId
            }

            const result = await this.computeClient.disks.beginCreateOrUpdateAndWait(source.targetResourceGroup, diskName, {
                location: source.sourceSnapshot.location,
                creationData: {
                    createOption: "Copy",
                    sourceResourceId: source.sourceSnapshot.id
                },
                tags: { ...allTags,
                    "smcp-recovery": JSON.stringify(tracking)
                }
            });

            newDisk = {
                id: result.id,
                name: diskName,
                osType: result.osType
            };

            return newDisk;

        } catch (error) {
            const message = `Unable to create disk from snapshot '${source.sourceSnapshot.id}' with error: ${_getString(error)}`;
            this.logger.error(message);
            throw new VmError(message);
        }
    }


    /**
     * Creates a network interface in the specified subnet using Azure SDK
     * @param resourceGroupName Resource group name
     * @param nicName Network interface name
     * @param subnetId Full subnet ID
     * @param location Azure region
     * @param useOriginalIpAddress Whether to use original IP or dynamic allocation
     * @param originalIpAddress Original IP address from snapshot (optional)
     * @returns Network interface details
     */
    private async createNetworkInterface(
        tracking: TrackingInfo,
        resourceGroupName: string, 
        nicName: string, 
        subnetId: string, 
        location: string,
        useOriginalIpAddress: boolean,
        originalIpAddress?: string
    ): Promise<VmNic> {

        try {
            this.logger.info(`Creating network interface ${nicName} in subnet ${subnetId}`);
            
            // Determine IP allocation method and address
            let ipConfiguration: any;
            
            if (useOriginalIpAddress && originalIpAddress) {
                this.logger.info(`Using static IP allocation with original IP: ${originalIpAddress}`);
                ipConfiguration = {
                    name: 'ipconfig1',
                    privateIPAllocationMethod: 'Static',
                    privateIPAddress: originalIpAddress,
                    subnet: {
                        id: subnetId
                    }
                };
            } else {
                if (useOriginalIpAddress && !originalIpAddress) {
                    this.logger.warn(`Original IP address requested but not available, falling back to dynamic allocation`);
                } else {
                    this.logger.info(`Using dynamic IP allocation`);
                }
                
                ipConfiguration = {
                    name: 'ipconfig1',
                    privateIPAllocationMethod: 'Dynamic',
                    subnet: {
                        id: subnetId
                    }
                };
            }

            // Add mandatory tags from environment variable
            let allTags = {};
            const mandatoryTags = JSON.parse(process.env.SMCP_MANDATORY_TAGS || "[]");
            for (const tag of mandatoryTags) {
                if (tag.key && tag.value) {
                    allTags[tag.key] = tag.value;
                }
            }

            // Create network interface using Azure SDK
            const nicParameters = {
                location: location,
                ipConfigurations: [ipConfiguration],
                tags: { ...allTags,
                    "smcp-recovery": JSON.stringify(tracking),
                    "ip-allocation": useOriginalIpAddress ? "static-requested" : "dynamic"
                }
            };

            const nicResult = await this.networkClient.networkInterfaces.beginCreateOrUpdateAndWait(
                resourceGroupName,
                nicName,
                nicParameters
            );

            const nicOutput: VmNic = {
                id: nicResult.id,
                name: nicName,
                ipAddress: nicResult.ipConfigurations?.[0]?.privateIPAddress || 'Unknown'
            };

            this.logger.info(`Successfully created network interface: ${nicOutput.id} with IP: ${nicOutput.ipAddress}`);
            return nicOutput;

        } catch (error) {
            const message = `Unable to create network interface ${nicName}: ${_getString(error)}`;
            this.logger.error(message);
            throw new VmError(message);
        }
    }


    public async createVirtualMachine(source: NewVmDetails, osDisk: VmDisk, jobId: string): Promise<VmInfo> {

        try {
            let newVm: VmInfo = null;

            // Tracking Id
            const tracking: TrackingInfo = {
                batchId: source.batchId,
                jobId: jobId
            }

            // Create network interface in the target subnet
            const nic = await this.createNetworkInterface(
                tracking,
                source.targetResourceGroup,
                `${source.sourceSnapshot.vmName}-nic`,
                source.targetSubnetId,
                source.sourceSnapshot.location,
                source.useOriginalIpAddress,
                source.sourceSnapshot.ipAddress
            );

            // Add mandatory tags from environment variable
            let allTags = {};
            const mandatoryTags = JSON.parse(process.env.SMCP_MANDATORY_TAGS || "[]");
            for (const tag of mandatoryTags) {
                if (tag.key && tag.value) {
                    allTags[tag.key] = tag.value;
                }
            }

            // Step 2: Create the virtual machine
            let vmConfig: any = {
                location: source.sourceSnapshot.location,
                hardwareProfile: { vmSize: source.sourceSnapshot.vmSize },
                storageProfile: {
                    osDisk: {
                        osType: osDisk.osType,
                        name: osDisk.name,
                        createOption: "Attach",
                        managedDisk: { id: osDisk.id }
                    }
                },
                // Note: When attaching existing OS disk, don't include osProfile
                // The OS configuration comes from the attached disk
                networkProfile: {
                    networkInterfaces: [{
                        id: nic.id,
                        primary: true
                    }]
                },
                // Enable boot diagnostics
                diagnosticsProfile: {
                    bootDiagnostics: {
                        enabled: true
                    }
                },
                tags: { ...allTags,
                    "smcp-recovery": JSON.stringify(tracking)
                }
            };

            // Only add security profile if source snapshot has TrustedLaunch security type
            if (source.sourceSnapshot.securityType === "TrustedLaunch") {
                vmConfig.securityProfile = {
                    uefiSettings: {
                        secureBootEnabled: true,
                        vTpmEnabled: true
                    },
                    securityType: "TrustedLaunch"
                };
                //this.logger.info(`Adding TrustedLaunch security profile to VM: ${source.sourceSnapshot.vmName}`);
            }

            const result = await this.computeClient.virtualMachines.beginCreateOrUpdateAndWait(source.targetResourceGroup, source.sourceSnapshot.vmName, vmConfig);

            newVm = {
                id: result.id,
                name: result.name,
                ipAddress: nic.ipAddress
            };

            this.logger.info(`Successfully created VM: ${newVm.name} with ID: ${newVm.id} and IP address: ${newVm.ipAddress}`);

            return newVm;

        } catch (error) {
            const message = `Unable to create vm from snapshot '${source.sourceSnapshot.id}' with error: ${_getString(error)}`;
            this.logger.error(message);
            throw new VmError(message);
        }
    }


    public async createVirtualMachineAsync(source: NewVmDetails, osDisk: VmDisk, jobId: string): Promise<VmCreationResult> {

        try {

            // Tracking Id
            const tracking: TrackingInfo = {
                batchId: source.batchId,
                jobId: jobId
            }

            // Create network interface in the target subnet
            const nic = await this.createNetworkInterface(
                tracking,
                source.targetResourceGroup,
                `${source.sourceSnapshot.vmName}-nic`,
                source.targetSubnetId,
                source.sourceSnapshot.location,
                source.useOriginalIpAddress,
                source.sourceSnapshot.ipAddress
            );

            // Step 2: Create the virtual machine
            let vmConfig: any = {
                location: source.sourceSnapshot.location,
                hardwareProfile: { vmSize: source.sourceSnapshot.vmSize },
                storageProfile: {
                    osDisk: {
                        osType: osDisk.osType,
                        name: osDisk.name,
                        createOption: "Attach",
                        managedDisk: { id: osDisk.id }
                    }
                },
                // Note: When attaching existing OS disk, don't include osProfile
                // The OS configuration comes from the attached disk
                networkProfile: {
                    networkInterfaces: [{
                        id: nic.id,
                        primary: true
                    }]
                },
                // Enable boot diagnostics
                diagnosticsProfile: {
                    bootDiagnostics: {
                        enabled: true
                    }
                },
                tags: { 
                    "smcp-recovery": JSON.stringify(tracking)
                }
            };

            // Only add security profile if source snapshot has TrustedLaunch security type
            if (source.sourceSnapshot.securityType === "TrustedLaunch") {
                vmConfig.securityProfile = {
                    uefiSettings: {
                        secureBootEnabled: true,
                        vTpmEnabled: true
                    },
                    securityType: "TrustedLaunch"
                };
                //this.logger.info(`Adding TrustedLaunch security profile to VM: ${source.sourceSnapshot.vmName}`);
            }

            // Start the async VM creation operation
            const poller = await this.computeClient.virtualMachines.beginCreateOrUpdate(source.targetResourceGroup, source.sourceSnapshot.vmName, vmConfig);
            const operationState = poller.getOperationState();
            
            // Generate a unique operation ID for tracking
            const operationId = `${source.sourceSnapshot.vmName}-${Date.now()}`;

            this.logger.info(`Started VM creation for: ${source.sourceSnapshot.vmName}, operation ID: ${operationId}, status: ${operationState.status}`);

            // Create message for queue-based polling
            const pollMessage: VmCreationPollMessage = {
                pollerUrl: poller.toString(), // This may contain serialized poller info
                operationId: operationId,
                vmName: source.sourceSnapshot.vmName,
                targetResourceGroup: source.targetResourceGroup,
                sourceSnapshot: source.sourceSnapshot,
                nicInfo: nic,
                jobId: jobId,
                batchId: source.batchId,
                createdAt: new Date().toISOString(),
                retryCount: 0
            };

            return {
                success: true,
                pollerMessage: pollMessage
            };

        } catch (error) {
            const message = `Unable to create vm from snapshot '${source.sourceSnapshot.id}' with error: ${_getString(error)}`;
            this.logger.error(message);
            return {
                success: false,
                error: message
            };
        }
    }

    /**
     * Check the status of a VM creation operation and return the result
     */
    public async checkVmCreationStatus(pollMessage: VmCreationPollMessage): Promise<VmCreationResult> {
        try {
            this.logger.info(`Checking VM creation status for: ${pollMessage.vmName}, operation ID: ${pollMessage.operationId}`);
            
            // Try to get the VM to check if creation is complete
            let vm;
            try {
                vm = await this.computeClient.virtualMachines.get(pollMessage.targetResourceGroup, pollMessage.vmName);
            } catch (error) {
                // VM doesn't exist yet or other error
                const errorMsg = _getString(error);
                if (errorMsg.includes('NotFound') || errorMsg.includes('ResourceNotFound')) {
                    // VM creation still in progress
                    this.logger.info(`VM ${pollMessage.vmName} still being created`);
                    return {
                        success: false,
                        error: 'VM creation still in progress',
                        pollerMessage: {
                            ...pollMessage,
                            retryCount: (pollMessage.retryCount || 0) + 1
                        }
                    };
                } else {
                    // Some other error occurred
                    this.logger.error(`Error checking VM status: ${errorMsg}`);
                    return {
                        success: false,
                        error: `Error checking VM status: ${errorMsg}`
                    };
                }
            }

            // VM exists, check provisioning state
            const provisioningState = vm.provisioningState;
            this.logger.info(`VM ${pollMessage.vmName} provisioning state: ${provisioningState}`);

            if (provisioningState === 'Succeeded') {
                // VM creation completed successfully
                const vmInfo: VmInfo = {
                    id: vm.id,
                    name: vm.name,
                    ipAddress: pollMessage.nicInfo.ipAddress
                };

                this.logger.info(`VM creation completed successfully: ${vmInfo.name} with IP: ${vmInfo.ipAddress}`);
                
                return {
                    success: true,
                    vmInfo: vmInfo
                };
            } else if (provisioningState === 'Failed') {
                // VM creation failed
                const errorMsg = `VM creation failed for ${pollMessage.vmName}, provisioning state: ${provisioningState}`;
                this.logger.error(errorMsg);
                
                return {
                    success: false,
                    error: errorMsg
                };
            } else {
                // VM creation still in progress (Creating, Updating, etc.)
                this.logger.info(`VM ${pollMessage.vmName} still in progress, state: ${provisioningState}`);
                
                return {
                    success: false,
                    error: `VM creation still in progress, state: ${provisioningState}`,
                    pollerMessage: {
                        ...pollMessage,
                        retryCount: (pollMessage.retryCount || 0) + 1
                    }
                };
            }

        } catch (error) {
            const message = `Unable to check VM creation status for '${pollMessage.vmName}' with error: ${_getString(error)}`;
            this.logger.error(message);
            
            return {
                success: false,
                error: message
            };
        }
    }

}
