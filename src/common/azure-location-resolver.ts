// Azure location resolver - gets actual location from Azure APIs
import { DefaultAzureCredential } from '@azure/identity';
import { parseSubnetId, getSubscriptionAndResourceGroups } from './azure-resource-utils';
import { ILogger } from './logger';
import { SubnetLocation } from './interfaces';

export class AzureLocationResolver {
  private logger: ILogger;

  constructor(logger: ILogger) {
    this.logger = logger;
  }

  /**
   * Gets location from subnet ID using REST API calls
   * @param subnetId Full subnet resource ID
   * @returns Location/region of the subnet
   */
  async getSubnetLocation(subnetId: string): Promise<string> {
    try {
      this.logger.info(`Getting location for subnet: ${subnetId}`);
      
      // Parse the subnet ID
      const parsed = parseSubnetId(subnetId);
      this.logger.info(`Parsed subnet - VNet: ${parsed.parentResourceName}, Subnet: ${parsed.resourceName}, RG: ${parsed.resourceGroupName}`);

      // Get access token
      const credential = new DefaultAzureCredential();
      const token = await credential.getToken('https://management.azure.com/.default');

      // Call Azure REST API to get virtual network info
      const vnetUrl = `https://management.azure.com/subscriptions/${parsed.subscriptionId}/resourceGroups/${parsed.resourceGroupName}/providers/Microsoft.Network/virtualNetworks/${parsed.parentResourceName}?api-version=2021-05-01`;
      
      const response = await fetch(vnetUrl, {
        headers: {
          'Authorization': `Bearer ${token.token}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const vnetData = await response.json();

      if (!vnetData.location) {
        throw new Error(`Virtual network ${parsed.parentResourceName} does not have a location`);
      }

      this.logger.info(`Found location: ${vnetData.location} for subnet ${parsed.resourceName}`);
      return vnetData.location;

    } catch (error) {
      this.logger.error(`Failed to get subnet location for ${subnetId}:`, error);
      throw new Error(`Could not determine location for subnet ${subnetId}: ${error.message}`);
    }
  }

  /**
   * Gets locations for multiple subnet IDs
   * @param subnetIds Array of subnet resource IDs
   * @returns Array of SubnetLocation objects
   */
  async getSubnetLocations(subnetIds: string[]): Promise<SubnetLocation[]> {
    try {
      this.logger.info(`Getting locations for ${subnetIds.length} subnets`);
      
      // Process all subnets in parallel
      const locationPromises = subnetIds.map(async (subnetId) => {
        try {
          const location = await this.getSubnetLocation(subnetId);
          return {
            subnetId,
            location
          } as SubnetLocation;
        } catch (error) {
          this.logger.error(`Failed to get location for subnet ${subnetId}:`, error);
          throw error;
        }
      });

      const results = await Promise.all(locationPromises);
      this.logger.info(`Successfully retrieved locations for ${results.length} subnets`);
      return results;

    } catch (error) {
      this.logger.error('Failed to get subnet locations:', error);
      throw new Error(`Could not determine locations for subnets: ${error.message}`);
    }
  }

  /**
   * Gets location from any Azure resource ID using REST API
   * @param resourceId Full Azure resource ID
   * @returns Location/region of the resource
   */
  async getResourceLocation(resourceId: string): Promise<string> {
    try {
      this.logger.info(`Getting location for resource: ${resourceId}`);
      
      // Get access token
      const credential = new DefaultAzureCredential();
      const token = await credential.getToken('https://management.azure.com/.default');

      // Call Azure REST API
      const resourceUrl = `https://management.azure.com${resourceId}?api-version=2021-04-01`;
      
      const response = await fetch(resourceUrl, {
        headers: {
          'Authorization': `Bearer ${token.token}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const resourceData = await response.json();

      if (!resourceData.location) {
        throw new Error(`Resource ${resourceId} does not have a location`);
      }

      this.logger.info(`Found location: ${resourceData.location} for resource`);
      return resourceData.location;

    } catch (error) {
      this.logger.error(`Failed to get resource location for ${resourceId}:`, error);
      throw new Error(`Could not determine location for resource ${resourceId}: ${error.message}`);
    }
  }

  /**
   * Gets location from resource group using REST API
   * @param subscriptionId Subscription ID
   * @param resourceGroupName Resource group name
   * @returns Location/region of the resource group
   */
  async getResourceGroupLocation(subscriptionId: string, resourceGroupName: string): Promise<string> {
    try {
      this.logger.info(`Getting location for resource group: ${resourceGroupName}`);

      // Get access token
      const credential = new DefaultAzureCredential();
      const token = await credential.getToken('https://management.azure.com/.default');

      // Call Azure REST API
      const rgUrl = `https://management.azure.com/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}?api-version=2021-04-01`;
      
      const response = await fetch(rgUrl, {
        headers: {
          'Authorization': `Bearer ${token.token}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const rgData = await response.json();

      if (!rgData.location) {
        throw new Error(`Resource group ${resourceGroupName} does not have a location`);
      }

      this.logger.info(`Found location: ${rgData.location} for resource group ${resourceGroupName}`);
      return rgData.location;

    } catch (error) {
      this.logger.error(`Failed to get resource group location for ${resourceGroupName}:`, error);
      throw new Error(`Could not determine location for resource group ${resourceGroupName}: ${error.message}`);
    }
  }

  /**
   * Gets location with fallback strategy:
   * 1. Try to get from the resource directly
   * 2. If that fails, get from the resource group
   * @param resourceId Full Azure resource ID
   * @returns Location/region
   */
  async getLocationWithFallback(resourceId: string): Promise<string> {
    try {
      // First try to get location directly from the resource
      return await this.getResourceLocation(resourceId);
    } catch (directError) {
      this.logger.warn(`Direct resource location lookup failed, trying resource group fallback:`, directError);
      
      try {
        // Fallback to getting location from resource group
        const { subscriptionId, resourceGroups } = getSubscriptionAndResourceGroups(resourceId);
        return await this.getResourceGroupLocation(subscriptionId, resourceGroups[0]);
      } catch (fallbackError) {
        this.logger.error(`Both direct and fallback location lookups failed:`, fallbackError);
        throw new Error(`Could not determine location for resource ${resourceId} using any method`);
      }
    }
  }
}

// Standalone utility functions for quick use
export class LocationUtils {
  /**
   * Quick method to get subnet location using the resolver
   * @param subnetId Subnet resource ID
   * @param logger Logger instance
   * @returns Location string
   */
  static async getSubnetLocation(subnetId: string, logger: ILogger): Promise<string> {
    const resolver = new AzureLocationResolver(logger);
    return await resolver.getSubnetLocation(subnetId);
  }

  /**
   * Quick method to get multiple subnet locations using the resolver
   * @param subnetIds Array of subnet resource IDs
   * @param logger Logger instance
   * @returns Array of SubnetLocation objects
   */
  static async getSubnetLocations(subnetIds: string[], logger: ILogger): Promise<SubnetLocation[]> {
    const resolver = new AzureLocationResolver(logger);
    return await resolver.getSubnetLocations(subnetIds);
  }

  /**
   * Quick method to get any resource location
   * @param resourceId Resource ID
   * @param logger Logger instance
   * @returns Location string
   */
  static async getResourceLocation(resourceId: string, logger: ILogger): Promise<string> {
    const resolver = new AzureLocationResolver(logger);
    return await resolver.getLocationWithFallback(resourceId);
  }
}