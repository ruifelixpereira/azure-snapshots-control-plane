# Azure Monitor Alerts for Failed Snapshots

In case of failed snapshots or backups in Azure, it's crucial to set up alerts that notify you promptly. This guide walks you through creating an Azure Monitor alert based on a KQL query and configuring an HTTP POST webhook action with a custom JSON payload.

## ✅ Step 1: Create the Log Analytics Query

1. Go to **Azure Portal → Log Analytics Workspace**.
2. Open Logs and write your KQL query. Example:

    ```kql
    SnapshotsOperations_CL
    | where jobType == "Snapshot"
    | extend resourceGroup = extract(@"/resourcegroups/([^/]+)", 1, tolower(sourceVmId))
    | where resourceGroup in~ ('snapshots-mng', 'scmp-snapshots', 'scale-test-rg')
    | where TimeGenerated > ago(5m)
    | summarize Operations = make_set(jobStatus) by jobId
    | extend IsFailed = Operations has "Snapshot Failed" and not(Operations has "Snapshot Completed")
    | summarize SnapshotsFailedCount = countif(IsFailed)
    ```

3. Test the query to ensure it returns the expected results.


## ✅ Step 2: Create an Alert Rule

1. Navigate to **Azure Monitor → Alerts → Alert rules → Create**.
2. Select **Resource** = your Log Analytics Workspace.
3. Under **Condition**:

    - Click **Add condition** → choose **Custom log search**.
    - Paste your KQL query.
    - Set **Evaluation period** and **Frequency** (e.g., every 5 minutes).
    - Define **Threshold** (e.g., greater than 0 results).


## ✅ Step 3: Create an Action Group

1. In the Actions section of the alert rule, click **Create action group**.
2. Provide:

    - **Name** and **Short name**.
    - **Resource group**.

3. Under **Actions**, click **Add action**:

    - **Action type** = Webhook.
    - **Name** = e.g., PostToWebhook.
    - **Webhook URI** = your endpoint URL. When creating your alert rule in Azure Monitor, configure the action group to use a webhook pointing to your function (e.g., `https://<your-function-app>.azurewebsites.net/api/alert?code=<function-key>`).

Make sure to enable **Use common alert schema** in the action group webhook configuration.


## ✅ Step 4: Customize properties in the JSON Payload
Azure Monitor allows you to customize additional properties in the payload using **Common Alert Schema**.

1. Under **Alert rule details**:

    - **Severity** = 1 - Error.
    - **Alert rule description** = e.g., Snapshots creation failed.

2. Expand **Advanced options** and add these **Custom properties**:

    - **AlertReason** = `${data.alertContext.condition.allOf[0].metricMeasureColumn} ${data.alertContext.condition.allOf[0].operator} ${data.alertContext.condition.allOf[0].threshold} ${data.essentials.monitorCondition}. The value is ${data.alertContext.condition.allOf[0].metricValue}.`



## ✅ Step 5: Review and Create

- Review all settings.
- Click **Create alert rule**.


## ✅ Step 6: Test the Webhook

- Trigger the alert by adjusting the query or threshold.
- Check your webhook endpoint logs to confirm the POST request and payload.
