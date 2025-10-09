// Bicep template to create 120 Ubuntu VMs for scale testing
// Creates VMs with no public IP, no NSG, and specific tags

@description('Number of VMs to create')
param vmCount int = 120

@description('VM size')
param vmSize string = 'Standard_B2ls_v2'

@description('VM name prefix')
param vmPrefix string = 'scale-test-vm'

@description('Location for all resources')
param location string = resourceGroup().location

@description('Admin username')
param adminUsername string = 'azureuser'

@description('SSH public key for authentication')
@secure()
param sshPublicKey string

@description('Virtual network name')
param vnetName string = 'scale-test-vnet'

@description('Subnet name')
param subnetName string = 'default'

// Virtual Network
resource vnet 'Microsoft.Network/virtualNetworks@2023-05-01' = {
  name: vnetName
  location: location
  properties: {
    addressSpace: {
      addressPrefixes: [
        '10.0.0.0/16'
      ]
    }
  }
}

// Subnet
resource subnet 'Microsoft.Network/virtualNetworks/subnets@2023-05-01' = {
  parent: vnet
  name: subnetName
  properties: {
    addressPrefix: '10.0.1.0/24'
  }
}

// Network Interfaces (no public IP, no NSG)
resource nics 'Microsoft.Network/networkInterfaces@2023-05-01' = [for i in range(1, vmCount): {
  name: '${vmPrefix}-${padLeft(i, 3, '0')}-nic'
  location: location
  properties: {
    ipConfigurations: [
      {
        name: 'ipconfig1'
        properties: {
          privateIPAllocationMethod: 'Dynamic'
          subnet: {
            id: subnet.id
          }
        }
      }
    ]
  }
  tags: {
    'smcp-backup': 'on'
    'purpose': 'scale-test'
  }
}]

// Virtual Machines
resource vms 'Microsoft.Compute/virtualMachines@2023-07-01' = [for i in range(1, vmCount): {
  name: '${vmPrefix}-${padLeft(i, 3, '0')}'
  location: location
  properties: {
    hardwareProfile: {
      vmSize: vmSize
    }
    osProfile: {
      computerName: '${vmPrefix}-${padLeft(i, 3, '0')}'
      adminUsername: adminUsername
      linuxConfiguration: {
        disablePasswordAuthentication: true
        ssh: {
          publicKeys: [
            {
              path: '/home/${adminUsername}/.ssh/authorized_keys'
              keyData: sshPublicKey
            }
          ]
        }
      }
    }
    storageProfile: {
      imageReference: {
        publisher: 'Canonical'
        offer: '0001-com-ubuntu-server-jammy'
        sku: '22_04-lts-gen2'
        version: 'latest'
      }
      osDisk: {
        name: '${vmPrefix}-${padLeft(i, 3, '0')}-osdisk'
        caching: 'ReadWrite'
        createOption: 'FromImage'
        managedDisk: {
          storageAccountType: 'Premium_LRS'
        }
      }
    }
    networkProfile: {
      networkInterfaces: [
        {
          id: nics[i-1].id
        }
      ]
    }
  }
  tags: {
    'smcp-backup': 'on'
    purpose: 'scale-test'
    'vm-number': string(i)
  }
}]

// Outputs
output vnetId string = vnet.id
output subnetId string = subnet.id
output vmNames array = [for i in range(1, vmCount): '${vmPrefix}-${padLeft(i, 3, '0')}']
output vmCount int = vmCount
output createdVMs object = {
  count: vmCount
  size: vmSize
  location: location
  tags: {
    'smcp-backup': 'on'
    'purpose': 'scale-test'
  }
}
