// Creates: Storage Account (with queues), App Service Plan, Function App (system assigned identity),
// Log Analytics Workspace, Data Collection Endpoint (DCE) and Data Collection Rule (DCR).
// Role assignments (Storage Blob Data Owner, Storage Queue Data Contributor, Monitoring Metrics Publisher, Contributor).
// Azure Monitor Workbook (from JSON file).

// Parameters
param prefix string = 'smcp' // prefix for resource names

param storageAccountName string = '${prefix}snapmngsa01'
param funcAppName string = '${prefix}snapmng-fa01'
param location string = resourceGroup().location
param appInsightsName string = '${prefix}snapmng-ai01'
param workspaceName string = '${prefix}snapmng-law01'
param backupTableName string = 'SnapshotsOperations_CL'
param backupDcrName string = '${prefix}snapmng-bck-dcr01'
param backupDceName string = '${prefix}snapmng-bck-dce01'
param backupWorkbookJson string
param recoveryTableName string = 'SnapshotsRecoveryJobs_CL'
param recoveryDcrName string = '${prefix}snapmng-rec-dcr01'
param recoveryDceName string = '${prefix}snapmng-rec-dce01'
param recoveryWorkbookJson string

@minLength(3)
@maxLength(24)
param saName string = toLower(storageAccountName)

// Variables
var deploymentStorageContainerName = 'deployment'

var queuesToCreate = [
  'snapshot-jobs'
  'copy-control'
  'purge-jobs'
  'purge-control'
  'dead-letter-snapshot-creation-jobs'
  'recovery-jobs'
  'vm-creation-control'
]

// Storage Account
resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: saName
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: 'Allow'
    }
    publicNetworkAccess: 'Enabled'
  }

  resource blobServices 'blobServices' = {
    name: 'default'
    properties: {
      deleteRetentionPolicy: {}
    }

    resource deploymentContainer 'containers' = {
      name: deploymentStorageContainerName
      properties: {
        publicAccess: 'None'
      }
    }
  }

  //resource queueservices 'queueServices' = {
  //  name: 'default'
  //  properties: {}
  //}

}


// Create the default queue service (required parent)
resource storageQueueService 'Microsoft.Storage/storageAccounts/queueServices@2021-09-01' = {
  name: 'default'
  parent: storageAccount
  properties: {}
}

// Create queues
resource queues 'Microsoft.Storage/storageAccounts/queueServices/queues@2021-09-01' = [for q in queuesToCreate: {
  name: q
  parent: storageQueueService
  properties: {}
}]

// App Service plan (Flex Consumption)
resource hostingPlan 'Microsoft.Web/serverfarms@2024-11-01' = {
  name: '${funcAppName}-plan'
  location: location
  kind: 'functionapp'
  sku: {
    name: 'FC1'
    tier: 'FlexConsumption'
  }
  properties: {
    reserved: true // Enables Linux
  }
}

// Function App
resource functionApp 'Microsoft.Web/sites@2024-11-01' = {
  name: funcAppName
  location: location
  kind: 'functionapp,linux'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: hostingPlan.id
    httpsOnly: true
    functionAppConfig:{
      runtime:{
        name: 'node'
        version: '20'
      }
      deployment: {
        storage: {
          type: 'blobContainer'
          value: '${storageAccount.properties.primaryEndpoints.blob}${deploymentStorageContainerName}'
          authentication: {
            type: 'SystemAssignedIdentity'
          }
        }
      }
      scaleAndConcurrency: {
        maximumInstanceCount: 100
        instanceMemoryMB: 2048
      }
    }
    siteConfig: {
      appSettings: [
        {
          name: 'AzureWebJobsStorage__accountname'
          value: storageAccount.name
        }
      ]
    }
  }

}

// Role Assignments for storage
// Check https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles/storage
resource blobRoleAssignment 'Microsoft.Authorization/roleAssignments@2020-04-01-preview' = {
  name: guid(functionApp.name, storageAccount.id, 'Storage Blob Data Owner')
  scope: storageAccount
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b') // Storage Blob Data Owner
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource queueRoleAssignment 'Microsoft.Authorization/roleAssignments@2020-04-01-preview' = {
  name: guid(functionApp.name, storageAccount.id, 'Storage Queue Data Contributor')
  scope: storageAccount
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '974c5e8b-45b9-4653-ba55-5f855dd0fb88') // Storage Queue Data Contributor

    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource tableRoleAssignment 'Microsoft.Authorization/roleAssignments@2020-04-01-preview' = {
  name: guid(functionApp.name, storageAccount.id, 'Storage Table Data Contributor')
  scope: storageAccount
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3') // Storage Table Data Contributor

    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// Log Analytics Workspace
resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2021-06-01' = {
  name: workspaceName
  location: location
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
  }
}

// Application Insights for Function App monitoring
resource applicationInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: appInsightsName
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logAnalytics.id
    IngestionMode: 'LogAnalytics'
    RetentionInDays: 30
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

// Log analytics ingestion
resource backupCustomTable 'Microsoft.OperationalInsights/workspaces/tables@2022-10-01' = {
  parent: logAnalytics
  name: backupTableName
  properties: {
    schema: {
      name: backupTableName
      columns: [
        {
          name: 'TimeGenerated'
          type: 'datetime'
        }
        {
          name: 'jobId'
          type: 'string'
        }
        {
          name: 'jobOperation'
          type: 'string'
        }
        {
          name: 'jobStatus'
          type: 'string'
        }
        {
          name: 'jobType'
          type: 'string'
        }
        {
          name: 'message'
          type: 'string'
        }
        {
          name: 'sourceVmId'
          type: 'string'
        }
        {
          name: 'sourceDiskId'
          type: 'string'
        }
        {
          name: 'primarySnapshotId'
          type: 'string'
        }
        {
          name: 'secondarySnapshotId'
          type: 'string'
        }
        {
          name: 'primaryLocation'
          type: 'string'
        }
        {
          name: 'secondaryLocation'
          type: 'string'
        }
      ]
    }
    plan: 'Analytics'
    totalRetentionInDays: 30
  }
}

// Data Collection Endpoint
resource backupDce 'Microsoft.Insights/dataCollectionEndpoints@2021-09-01-preview' = {
  name: backupDceName
  location: location
  properties: {}
}

resource backupDcr 'Microsoft.Insights/dataCollectionRules@2021-09-01-preview' = {
  name: backupDcrName
  location: location
  properties: {
    dataCollectionEndpointId: backupDce.id
    streamDeclarations: {
        'Custom-${backupTableName}-source': {
            columns: [
                {
                  name: 'TimeGenerated'
                  type: 'datetime'
                }
                {
                  name: 'jobId'
                  type: 'string'
                }
                {
                  name: 'jobOperation'
                  type: 'string'
                }
                {
                  name: 'jobStatus'
                  type: 'string'
                }
                {
                  name: 'jobType'
                  type: 'string'
                }
                {
                  name: 'message'
                  type: 'string'
                }
                {
                  name: 'sourceVmId'
                  type: 'string'
                }
                {
                  name: 'sourceDiskId'
                  type: 'string'
                }
                {
                  name: 'primarySnapshotId'
                  type: 'string'
                }
                {
                  name: 'secondarySnapshotId'
                  type: 'string'
                }
                {
                  name: 'primaryLocation'
                  type: 'string'
                }
                {
                  name: 'secondaryLocation'
                  type: 'string'
                }
            ]
        }
    }
    destinations: {
      logAnalytics: [
        {
          name: 'laDest'
          workspaceResourceId: logAnalytics.id
        }
      ]
    }
    dataFlows: [
      {
        streams: [
          'Custom-${backupTableName}-source'
        ]
        destinations: [
          'laDest'
        ]
        transformKql: 'source | project TimeGenerated, jobId, jobOperation, jobStatus, jobType, message, sourceVmId, sourceDiskId, primarySnapshotId, secondarySnapshotId, primaryLocation, secondaryLocation'
        outputStream: 'Custom-${backupTableName}'
      }
    ]
  }
}

resource recoveryCustomTable 'Microsoft.OperationalInsights/workspaces/tables@2022-10-01' = {
  parent: logAnalytics
  name: recoveryTableName
  properties: {
    schema: {
      name: recoveryTableName
      columns: [
        {
          name: 'TimeGenerated'
          type: 'datetime'
        }
        {
          name: 'batchId'
          type: 'string'
        }
        {
          name: 'jobId'
          type: 'string'
        }
        {
          name: 'jobOperation'
          type: 'string'
        }
        {
          name: 'jobStatus'
          type: 'string'
        }
        {
          name: 'jobType'
          type: 'string'
        }
        {
          name: 'message'
          type: 'string'
        }
        {
          name: 'snapshotId'
          type: 'string'
        }
        {
          name: 'snapshotName'
          type: 'string'
        }
        {
          name: 'vmName'
          type: 'string'
        }
        {
          name: 'vmSize'
          type: 'string'
        }
        {
          name: 'diskSku'
          type: 'string'
        }
        {
          name: 'diskProfile'
          type: 'string'
        }
        {
          name: 'vmId'
          type: 'string'
        }
        {
          name: 'ipAddress'
          type: 'string'
        }
      ]
    }
    plan: 'Analytics'
    totalRetentionInDays: 30
  }
}

// Data Collection Endpoint
resource recoveryDce 'Microsoft.Insights/dataCollectionEndpoints@2021-09-01-preview' = {
  name: recoveryDceName
  location: location
  properties: {}
}

resource recoveryDcr 'Microsoft.Insights/dataCollectionRules@2021-09-01-preview' = {
  name: recoveryDcrName
  location: location
  properties: {
    dataCollectionEndpointId: recoveryDce.id
    streamDeclarations: {
        'Custom-${recoveryTableName}-source': {
            columns: [
                {
                  name: 'TimeGenerated'
                  type: 'datetime'
                }
                {
                  name: 'batchId'
                  type: 'string'
                }
                {
                  name: 'jobId'
                  type: 'string'
                }
                {
                  name: 'jobOperation'
                  type: 'string'
                }
                {
                  name: 'jobStatus'
                  type: 'string'
                }
                {
                  name: 'jobType'
                  type: 'string'
                }
                {
                  name: 'message'
                  type: 'string'
                }
                {
                  name: 'snapshotId'
                  type: 'string'
                }
                {
                  name: 'snapshotName'
                  type: 'string'
                }
                {
                  name: 'vmName'
                  type: 'string'
                }
                {
                  name: 'vmSize'
                  type: 'string'
                }
                {
                  name: 'diskSku'
                  type: 'string'
                }
                {
                  name: 'diskProfile'
                  type: 'string'
                }
                {
                  name: 'vmId'
                  type: 'string'
                }
                {
                  name: 'ipAddress'
                  type: 'string'
                }
            ]
        }
    }
    destinations: {
      logAnalytics: [
        {
          name: 'laDest'
          workspaceResourceId: logAnalytics.id
        }
      ]
    }
    dataFlows: [
      {
        streams: [
          'Custom-${recoveryTableName}-source'
        ]
        destinations: [
          'laDest'
        ]
        transformKql: 'source | project TimeGenerated, batchId, jobId, jobOperation, jobStatus, jobType, message, snapshotId, snapshotName, vmName, vmSize, diskSku, diskProfile, vmId, ipAddress'
        outputStream: 'Custom-${recoveryTableName}'
      }
    ]
  }
}

// Role Assignments for log analytics
resource monitoringMetricsPublisherRoleAssignment 'Microsoft.Authorization/roleAssignments@2020-04-01-preview' = {
  name: guid(functionApp.name, resourceGroup().id, 'Monitoring Metrics Publisher')
  scope: resourceGroup()
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '3913510d-42f4-4e42-8a64-420c390055eb') // Monitoring Metrics Publisher
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource contributorRoleAssignment 'Microsoft.Authorization/roleAssignments@2020-04-01-preview' = {
  name: guid(functionApp.name, resourceGroup().id, 'Contributor')
  scope: resourceGroup()
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b24988ac-6180-42a0-ab88-20f7382dd24c') // Contributor role
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// Function App settings
resource appSettings 'Microsoft.Web/sites/config@2022-03-01' = {
  parent: functionApp
  name: 'appsettings'
  properties: {
    AzureWebJobsStorage__accountname: storageAccount.name
    APPLICATIONINSIGHTS_CONNECTION_STRING: applicationInsights.properties.ConnectionString
    APPINSIGHTS_INSTRUMENTATIONKEY: applicationInsights.properties.InstrumentationKey
    SMCP_BCK_LOGS_INGESTION_ENDPOINT: backupDce.properties.logsIngestion.endpoint
    SMCP_BCK_LOGS_INGESTION_RULE_ID: backupDcr.properties.immutableId
    SMCP_BCK_LOGS_INGESTION_STREAM_NAME: 'Custom-${backupTableName}-source'
    SMCP_BCK_SECONDARY_LOCATION: 'westeurope'
    SMCP_BCK_TARGET_RESOURCE_GROUP: 'xpto-rg'
    SMCP_BCK_RETRY_CONTROL_COPY_MINUTES: '2'
    SMCP_BCK_RETRY_CONTROL_PURGE_MINUTES: '2'
    SMCP_BCK_PURGE_PRIMARY_LOCATION_NUMBER_OF_DAYS: '2'
    SMCP_BCK_PURGE_SECONDARY_LOCATION_NUMBER_OF_DAYS: '7'
    SMCP_BCK_BACKUP_TRIGGER_TAG: '{"key":"smcp-backup","value":"on"}'
    SMCP_REC_LOGS_INGESTION_ENDPOINT: recoveryDce.properties.logsIngestion.endpoint
    SMCP_REC_LOGS_INGESTION_RULE_ID: recoveryDcr.properties.immutableId
    SMCP_REC_LOGS_INGESTION_STREAM_NAME: 'Custom-${recoveryTableName}-source'
    SMCP_REC_BATCH_SIZE: '20'
    SMCP_REC_DELAY_BETWEEN_BATCHES: '10'
    SMCP_REC_VM_POLL_MAX_RETRIES: '30'
    SMCP_REC_VM_POLL_DELAY_SECONDS: '60'
    SMCP_REC_VM_POLL_MAX_DELAY_SECONDS: '600'
    SMCP_MANDATORY_TAGS: '[{"key":"app","value":"xpto"},{"key":"owner","value":"zzzzz"}]'
  }
}

// Azure Monitor Workbook
resource backupWorkbook 'Microsoft.Insights/workbooks@2023-06-01' = {
  name: guid(resourceGroup().id, 'AzureSnapshotsInsightsWorkbook')
  location: resourceGroup().location
  kind: 'shared'
  properties: {
    displayName: 'Azure Snapshots Insights'
    category: 'workbook'
    sourceId: resourceGroup().id
    serializedData: backupWorkbookJson
    version: '1.0'
  }
}

resource recoveryWorkbook 'Microsoft.Insights/workbooks@2023-06-01' = {
  name: guid(resourceGroup().id, 'AzureSnapshotsRecoveryInsightsWorkbook')
  location: resourceGroup().location
  kind: 'shared'
  properties: {
    displayName: 'Azure Snapshots Recovery Insights'
    category: 'workbook'
    sourceId: resourceGroup().id
    serializedData: recoveryWorkbookJson
    version: '1.0'
  }
}

// Outputs
output storageAccountId string = storageAccount.id
output functionAppIdentityPrincipalId string = functionApp.identity.principalId
output functionAppName string = functionApp.name
output logAnalyticsWorkspaceName string = logAnalytics.name
output applicationInsightsName string = applicationInsights.name
output applicationInsightsInstrumentationKey string = applicationInsights.properties.InstrumentationKey
output applicationInsightsConnectionString string = applicationInsights.properties.ConnectionString
