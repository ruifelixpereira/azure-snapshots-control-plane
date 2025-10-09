// Service Principal Setup for Local Development
// This Bicep template creates role assignments for a service principal
// The service principal itself must be created via Azure CLI/PowerShell

@description('The prefix for resource names')
param prefix string = 'smcp'

@description('The name of the storage account')
param storageAccountName string = '${prefix}snapmngsa01'

@description('The name of the data collection rule for backup')
param backupDcrName string = '${prefix}snapmng-bck-dcr01'

@description('The name of the data collection rule for recovery')
param recoveryDcrName string = '${prefix}snapmng-rec-dcr01'

@description('The name of the data collection endpoint for backup')
param backupDceName string = '${prefix}snapmng-bck-dce01'

@description('The name of the data collection endpoint for recovery')
param recoveryDceName string = '${prefix}snapmng-rec-dce01'

@description('The name of the workspace table for backup')
param backupTableName string = 'SnapshotsOperations_CL'

@description('The name of the workspace table for recovery')
param recoveryTableName string = 'SnapshotsRecoveryJobs_CL'

@description('The object ID (principal ID) of the service principal')
param servicePrincipalObjectId string

@description('The application (client) ID of the service principal')
param servicePrincipalClientId string

@description('The display name for the service principal')
param servicePrincipalDisplayName string = 'local-dev-service-principal'

// Reference existing resources
resource existingStorageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}

resource existingBackupDcr 'Microsoft.Insights/dataCollectionRules@2021-09-01-preview' existing = {
  name: backupDcrName
}

resource existingRecoveryDcr 'Microsoft.Insights/dataCollectionRules@2021-09-01-preview' existing = {
  name: recoveryDcrName
}

resource existingBackupDce 'Microsoft.Insights/dataCollectionEndpoints@2021-09-01-preview' existing = {
  name: backupDceName
}

resource existingRecoveryDce 'Microsoft.Insights/dataCollectionEndpoints@2021-09-01-preview' existing = {
  name: recoveryDceName
}

// Storage Account Role Assignments
resource storageAccountBlobDataOwnerRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(servicePrincipalObjectId, existingStorageAccount.id, 'Storage Blob Data Owner')
  scope: existingStorageAccount
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b') // Storage Blob Data Owner
    principalId: servicePrincipalObjectId
    principalType: 'ServicePrincipal'
    description: 'Allows service principal to manage storage blobs for local development'
  }
}

resource storageAccountQueueDataContributorRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(servicePrincipalObjectId, existingStorageAccount.id, 'Storage Queue Data Contributor')
  scope: existingStorageAccount
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '974c5e8b-45b9-4653-ba55-5f855dd0fb88') // Storage Queue Data Contributor
    principalId: servicePrincipalObjectId
    principalType: 'ServicePrincipal'
    description: 'Allows service principal to manage storage queues for local development'
  }
}

resource storageAccountTableDataContributorRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(servicePrincipalObjectId, existingStorageAccount.id, 'Storage Table Data Contributor')
  scope: existingStorageAccount
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3') // Storage Table Data Contributor
    principalId: servicePrincipalObjectId
    principalType: 'ServicePrincipal'
    description: 'Allows service principal to manage storage tables for local development'
  }
}

// Resource Group Level Role Assignments
resource monitoringMetricsPublisherRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(servicePrincipalObjectId, resourceGroup().id, 'Monitoring Metrics Publisher')
  scope: resourceGroup()
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '3913510d-42f4-4e42-8a64-420c390055eb') // Monitoring Metrics Publisher
    principalId: servicePrincipalObjectId
    principalType: 'ServicePrincipal'
    description: 'Allows service principal to publish metrics for local development'
  }
}

/*
resource contributorRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(servicePrincipalObjectId, resourceGroup().id, 'Contributor')
  scope: resourceGroup()
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b24988ac-6180-42a0-ab88-20f7382dd24c') // Contributor
    principalId: servicePrincipalObjectId
    principalType: 'ServicePrincipal'
    description: 'Allows service principal to manage resources for local development'
  }
}
*/


// Outputs
output servicePrincipalClientId string = servicePrincipalClientId
output servicePrincipalObjectId string = servicePrincipalObjectId
output servicePrincipalDisplayName string = servicePrincipalDisplayName

// Generate local.settings.json structure
output localSettingsJson object = {
  IsEncrypted: false
  Values: {
    FUNCTIONS_WORKER_RUNTIME: 'node'
    AzureWebJobsStorage__accountname: existingStorageAccount.name
    AZURE_TENANT_ID: subscription().tenantId
    AZURE_CLIENT_ID: servicePrincipalClientId
    SMCP_BCK_LOGS_INGESTION_ENDPOINT: existingBackupDce.properties.logsIngestion.endpoint
    SMCP_BCK_LOGS_INGESTION_RULE_ID: existingBackupDcr.properties.immutableId
    SMCP_BCK_LOGS_INGESTION_STREAM_NAME: 'Custom-${backupTableName}-source'
    SMCP_BCK_SECONDARY_LOCATION: 'westeurope'
    SMCP_BCK_TARGET_RESOURCE_GROUP: 'xpto-rg'
    SMCP_BCK_RETRY_CONTROL_COPY_MINUTES: '10'
    SMCP_BCK_RETRY_CONTROL_PURGE_MINUTES: '10'
    SMCP_BCK_PURGE_PRIMARY_LOCATION_NUMBER_OF_DAYS: '1'
    SMCP_BCK_PURGE_SECONDARY_LOCATION_NUMBER_OF_DAYS: '11'
    SMCP_BCK_BACKUP_TRIGGER_TAG: '{"key":"smcp-backup","value":"on"}'
    SMCP_REC_LOGS_INGESTION_ENDPOINT: existingRecoveryDce.properties.logsIngestion.endpoint
    SMCP_REC_LOGS_INGESTION_RULE_ID: existingRecoveryDcr.properties.immutableId
    SMCP_REC_LOGS_INGESTION_STREAM_NAME: 'Custom-${recoveryTableName}-source'
    SMCP_REC_BATCH_SIZE: '20'
    SMCP_REC_DELAY_BETWEEN_BATCHES: '10'
    SMCP_REC_VM_POLL_MAX_RETRIES: '30'
    SMCP_REC_VM_POLL_DELAY_SECONDS: '60'
    SMCP_REC_VM_POLL_MAX_DELAY_SECONDS: '600'
    SMCP_MANDATORY_TAGS: '[{"key":"app","value":"xpto"},{"key":"owner","value":"zzzzz"}]'
  }
}

// Summary of permissions granted
output permissionsSummary array = [
  'Storage Blob Data Owner on ${existingStorageAccount.name}'
  'Storage Queue Data Contributor on ${existingStorageAccount.name}'
  'Storage Table Data Contributor on ${existingStorageAccount.name}'
  'Monitoring Metrics Publisher on Resource Group'
  'Contributor on Resource Group'
]
