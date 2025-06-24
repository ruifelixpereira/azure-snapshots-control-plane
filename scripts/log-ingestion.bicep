
param location string = resourceGroup().location
param workspaceName string = 'my-laworkspace'
param tableName string = 'MyCustomTable'
param dcrName string = 'my-dcr'
param dceName string = 'my-dce'

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

resource customTable 'Microsoft.OperationalInsights/workspaces/tables@2022-10-01' = {
  name: '${workspaceName}/${tableName}'
  properties: {
    schema: {
      name: tableName
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
  dependsOn: [
    logAnalytics
  ]
}

// Data Collection Endpoint
resource dce 'Microsoft.Insights/dataCollectionEndpoints@2021-09-01-preview' = {
  name: dceName
  location: location
  properties: {}
}

resource dcr 'Microsoft.Insights/dataCollectionRules@2021-09-01-preview' = {
  name: dcrName
  location: location
  properties: {
    dataCollectionEndpointId: dce.id
    streamDeclarations: {
        'Custom-${tableName}-source': {
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
          'Custom-${tableName}-source'
        ]
        destinations: [
          'laDest'
        ]
        transformKql: 'source | project TimeGenerated, jobId, jobOperation, jobStatus, jobType, message, sourceVmId, sourceDiskId, primarySnapshotId, secondarySnapshotId, primaryLocation, secondaryLocation'
        outputStream: 'Custom-${tableName}'
      }
    ]
  }
}


output logIngestionEndpoint string = dce.properties.logsIngestion.endpoint
output logIngestionRuleId string = dcr.properties.immutableId
output logIngestionStreamName string = 'Custom-${tableName}-source'
