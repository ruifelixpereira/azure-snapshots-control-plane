# Helper copmmands for removing old snapshots

To remove all the snapshots from day 20251105 in resource group RESOURCE_RG, run:

```bash
az snapshot list --resource-group RESOURCE_RG \
  --query "[?starts_with(name, 's20251105')].name" -o tsv | \
  xargs -I {} az snapshot delete --resource-group RESOURCE_RG --no-wait --name {}
```
