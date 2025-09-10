import { TableClient, odata } from "@azure/data-tables";
import { DefaultAzureCredential } from "@azure/identity";

export class ConcurrencyManager {
  private client: TableClient;
  private tableName = "CopyConcurrency";

  constructor(private accountName: string, private tableConnectionString?: string) {
    // Prefer connection string if present (Functions local), otherwise build URL with DefaultAzureCredential
    if (tableConnectionString) {
      this.client = TableClient.fromConnectionString(tableConnectionString, this.tableName);
    } else {
      const tableUrl = `https://${accountName}.table.core.windows.net`;
      const cred = new DefaultAzureCredential();
      this.client = new TableClient(tableUrl, this.tableName, cred);
    }
  }

  async ensureTable(): Promise<void> {
    try {
      await this.client.createTable();
    } catch (e: any) {
      // ignore if already exists
      if (!/TableNotFound|TableAlreadyExists/i.test(e.message)) {
        throw e;
      }
    }
  }

  // Try to acquire a slot atomically, returns true if acquired
  async acquireSlot(limit = 100, maxRetries = 5): Promise<boolean> {
    await this.ensureTable();
    const pk = "copy";
    const rk = "counter";
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        // Read entity if exists
        const entity = await this.client.getEntity<{ count: number }>(pk, rk).catch(() => undefined);
        if (!entity) {
          // create entity with count = 1 if limit >= 1
          const init = { partitionKey: pk, rowKey: rk, count: 1 };
          if (limit < 1) return false;
          await this.client.createEntity(init);
          return true;
        }
        const count = (entity as any).count ?? 0;
        if (count >= limit) return false;
        // optimistic update using ETag
        (entity as any).count = count + 1;
        //await this.client.updateEntity(entity as any, "Replace", { etag: (entity as any).etag, matchCondition: "IfNotModified" });
        await this.client.updateEntity(entity as any, "Replace", { etag: (entity as any).etag });
        return true;
      } catch (err: any) {
        // If ETag conflict, retry
        if (/Precondition Failed|412/i.test(err.message) || err.statusCode === 412) {
          await new Promise(r => setTimeout(r, 50 * (attempt + 1)));
          continue;
        }
        // If entity doesn't exist race created between read and create, loop retry
        if (/Not Found/i.test(err.message)) {
          await new Promise(r => setTimeout(r, 50));
          continue;
        }
        throw err;
      }
    }
    return false;
  }

  // Release previously acquired slot
  async releaseSlot(maxRetries = 5): Promise<void> {
    const pk = "copy";
    const rk = "counter";
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const entity = await this.client.getEntity<{ count: number }>(pk, rk);
        const count = (entity as any).count ?? 0;
        const newCount = Math.max(0, count - 1);
        (entity as any).count = newCount;
        //await this.client.updateEntity(entity as any, "Replace", { etag: (entity as any).etag, matchCondition: "IfNotModified" });
        await this.client.updateEntity(entity as any, "Replace", { etag: (entity as any).etag });
        return;
      } catch (err: any) {
        if (/Precondition Failed|412/i.test(err.message)) {
          await new Promise(r => setTimeout(r, 50 * (attempt + 1)));
          continue;
        }
        // If not found, nothing to release
        if (err.statusCode === 404) return;
        throw err;
      }
    }
  }

  // Read current active count (optional)
  async currentCount(): Promise<number> {
    const pk = "copy";
    const rk = "counter";
    const entity = await this.client.getEntity<{ count: number }>(pk, rk).catch(() => undefined);
    return entity ? ((entity as any).count ?? 0) : 0;
  }
}