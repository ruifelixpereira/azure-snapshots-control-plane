// Azure Resource ID utilities for extracting location and other information
// This module helps parse Azure Resource IDs and extract location information

export interface AzureResourceId {
  subscriptionId: string;
  resourceGroupName: string;
  location?: string;
  resourceProvider: string;
  resourceType: string;
  resourceName: string;
  parentResourceName?: string;
  fullId: string;
}

/**
 * Parses an Azure resource ID and extracts its components
 * @param resourceId Full Azure resource ID
 * @returns Parsed resource ID components
 */
export function parseAzureResourceId(resourceId: string): AzureResourceId {
  if (!resourceId) {
    throw new Error('Resource ID cannot be empty');
  }

  // Azure Resource ID format:
  // /subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}/providers/{resourceProvider}/{resourceType}/{resourceName}
  // Example subnet ID:
  // /subscriptions/12345678-1234-1234-1234-123456789abc/resourceGroups/myRG/providers/Microsoft.Network/virtualNetworks/myVNet/subnets/mySubnet

  const parts = resourceId.split('/').filter(part => part.length > 0);
  
  if (parts.length < 8) {
    throw new Error(`Invalid Azure resource ID format (length): ${resourceId}`);
  }

  const subscriptionIndex = parts.indexOf('subscriptions');
  const resourceGroupIndex = parts.findIndex(part => part.toLowerCase() === 'resourcegroups');
  const providersIndex = parts.indexOf('providers');

  if (subscriptionIndex === -1 || resourceGroupIndex === -1 || providersIndex === -1) {
    throw new Error(`Invalid Azure resource ID format: ${resourceId}`);
  }

  const subscriptionId = parts[subscriptionIndex + 1];
  const resourceGroupName = parts[resourceGroupIndex + 1];
  const resourceProvider = parts[providersIndex + 1];
  
  // For nested resources like subnets
  let resourceType: string;
  let resourceName: string;
  let parentResourceName: string | undefined;

  if (parts.length > providersIndex + 4) {
    // This is a nested resource (e.g., subnet within a virtual network)
    resourceType = `${parts[providersIndex + 2]}/${parts[providersIndex + 4]}`;
    resourceName = parts[parts.length - 1];
    parentResourceName = parts[parts.length - 3];
  } else {
    resourceType = parts[providersIndex + 2];
    resourceName = parts[parts.length - 1];
  }

  return {
    subscriptionId,
    resourceGroupName,
    resourceProvider,
    resourceType,
    resourceName,
    parentResourceName,
    fullId: resourceId
  };
}

/**
 * Extracts location from subnet ID by parsing the resource ID
 * Note: This method requires calling Azure APIs to get the actual location
 * @param subnetId Full subnet resource ID
 * @returns Resource components that can be used to query for location
 */
export function parseSubnetId(subnetId: string): AzureResourceId {
  const parsed = parseAzureResourceId(subnetId);
  
  if (parsed.resourceProvider !== 'Microsoft.Network' || !parsed.resourceType.includes('subnets')) {
    throw new Error(`Invalid subnet ID format: ${subnetId}`);
  }

  return parsed;
}

/**
 * Quick method to extract subscription and resource group from any Azure resource ID
 * @param resourceId Azure resource ID
 * @returns Object with subscriptionId and resourceGroupName
 */
export function getSubscriptionAndResourceGroups(snapshotResourceId: string, sourceVmResourceId?: string): { subscriptionId: string; resourceGroups: string[] } {
  const parsedSnap = parseAzureResourceId(snapshotResourceId);
  const parsedVm = sourceVmResourceId ? parseAzureResourceId(sourceVmResourceId) : undefined;
  return {
    subscriptionId: parsedSnap.subscriptionId,
    resourceGroups: parsedVm ? [ parsedSnap.resourceGroupName, parsedVm.resourceGroupName ] : [ parsedSnap.resourceGroupName ]
  };
}

/**
 * Extracts virtual network name from subnet ID
 * @param subnetId Subnet resource ID
 * @returns Virtual network name
 */
export function getVirtualNetworkNameFromSubnetId(subnetId: string): string {
  const parsed = parseSubnetId(subnetId);
  if (!parsed.parentResourceName) {
    throw new Error(`Cannot extract virtual network name from subnet ID: ${subnetId}`);
  }
  return parsed.parentResourceName;
}

/**
 * Extracts subnet name from subnet ID
 * @param subnetId Subnet resource ID  
 * @returns Subnet name
 */
export function getSubnetNameFromSubnetId(subnetId: string): string {
  const parsed = parseSubnetId(subnetId);
  return parsed.resourceName;
}

// Example usage and test cases
export const examples = {
  subnetId: '/subscriptions/12345678-1234-1234-1234-123456789abc/resourceGroups/myRG/providers/Microsoft.Network/virtualNetworks/myVNet/subnets/mySubnet',
  vmId: '/subscriptions/12345678-1234-1234-1234-123456789abc/resourceGroups/myRG/providers/Microsoft.Compute/virtualMachines/myVM',
  storageId: '/subscriptions/12345678-1234-1234-1234-123456789abc/resourceGroups/myRG/providers/Microsoft.Storage/storageAccounts/mystorageaccount'
};

// Test function to validate parsing
export function testResourceIdParsing(): void {
  console.log('Testing subnet ID parsing...');
  
  const subnetParsed = parseSubnetId(examples.subnetId);
  console.log('Subnet parsed:', subnetParsed);
  
  const vnetName = getVirtualNetworkNameFromSubnetId(examples.subnetId);
  console.log('VNet name:', vnetName);
  
  const subnetName = getSubnetNameFromSubnetId(examples.subnetId);
  console.log('Subnet name:', subnetName);
}