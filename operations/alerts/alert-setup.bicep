param actionGroups_post_webhook_url string
param logAnalyticsWorkspace_resource_id string 

var actionGroups_post_webhook_name = 'Post failed snapshots message'
var alertRule_name = 'Failed snapshots'

// Action group to post json to webhook
resource actionGroups_post_webhook_resource 'microsoft.insights/actionGroups@2024-10-01-preview' = {
  name: actionGroups_post_webhook_name
  location: 'Global'
  properties: {
    groupShortName: 'Failed snaps'
    enabled: true
    emailReceivers: []
    smsReceivers: []
    webhookReceivers: [
      {
        name: 'Post failed snapshots'
        serviceUri: actionGroups_post_webhook_url
        useCommonAlertSchema: true
        useAadAuth: false
      }
    ]
    eventHubReceivers: []
    itsmReceivers: []
    azureAppPushReceivers: []
    automationRunbookReceivers: []
    voiceReceivers: []
    logicAppReceivers: []
    azureFunctionReceivers: []
    armRoleReceivers: []
  }
}

// Alert rule for failed snapshots
resource scheduledqueryrules_Failed_snapshots_name_resource 'microsoft.insights/scheduledqueryrules@2025-01-01-preview' = {
  name: alertRule_name
  location: resourceGroup().location
  kind: 'LogAlert'
  properties: {
    displayName: alertRule_name
    description: 'Snapshots creation failed'
    severity: 1
    enabled: true
    evaluationFrequency: 'PT5M'
    scopes: [
      logAnalyticsWorkspace_resource_id
    ]
    targetResourceTypes: [
      'Microsoft.OperationalInsights/workspaces'
    ]
    windowSize: 'PT5M'
    overrideQueryTimeRange: 'P2D'
    criteria: {
      allOf: [
        {
          query: 'SnapshotsOperations_CL\n| where jobType == "Snapshot"\n| extend resourceGroup = extract(@"/resourcegroups/([^/]+)", 1, tolower(sourceVmId))\n| where resourceGroup in~ (\'snapshots-mng\', \'scmp-snapshots\', \'scale-test-rg\')\n| where TimeGenerated > ago(5m)\n| summarize Operations = make_set(jobStatus) by jobId\n| extend IsFailed = Operations has "Snapshot Failed" and not(Operations has "Snapshot Completed")\n| summarize SnapshotsFailedCount = countif(IsFailed)\n\n'
          timeAggregation: 'Total'
          metricMeasureColumn: 'SnapshotsFailedCount'
          dimensions: []
          operator: 'GreaterThan'
          threshold: 1
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    autoMitigate: false
    actions: {
      actionGroups: [
        actionGroups_post_webhook_resource.id
      ]
      customProperties: {
        Name: 'Servers daily snapshosts failed'
        Team: 'INFRA CORE Cloud & DC'
        metricName: '\${data.alertContext.condition.allOf[0].metricMeasureColumn}'
        metricValue: '\${data.alertContext.condition.allOf[0].metricValue}'
        severity: '2'
        threshold: '8*5'
      }
      actionProperties: {}
    }
  }
}
