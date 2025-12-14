# Locks Least‑privilege option (recommended)

Create a custom RBAC role that only grants lock operations and assign it to the service principal or managed identity at the RG scope.

Required actions
- Microsoft.Authorization/locks/read
- Microsoft.Authorization/locks/write
- Microsoft.Authorization/locks/delete

Example role definition (lock-admin.json):
```json
{
  "Name": "Lock Administrator",
  "IsCustom": true,
  "Description": "Can manage locks on resource groups.",
  "Actions": [
    "Microsoft.Authorization/locks/read",
    "Microsoft.Authorization/locks/write",
    "Microsoft.Authorization/locks/delete"
  ],
  "NotActions": [],
  "DataActions": [],
  "NotDataActions": [],
  "AssignableScopes": [
    "/subscriptions/<subId>/resourceGroups/<rg-name>"
  ]
}
```

Copy the provided `lock-admin-template.json` file to a new file `lock-admin.json` and change `<subId>` and `<rg-name>` to your subscription ID and resource group name. Then run:
    
```bash
az role definition create --role-definition ./scripts/lock/lock-admin.json
```
