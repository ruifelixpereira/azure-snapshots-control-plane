import { TableClient, odata } from "@azure/data-tables";
import { DefaultAzureCredential } from "@azure/identity";
import { RestError } from "@azure/core-http"; // optional, used only for typing checks

// Add near top of file (below class declaration or as private static helpers)
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  retries = 6,
  baseMs = 100,
  maxMs = 5000,
  factor = 2
): Promise<T> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      // detect transient errors: DNS EAI_AGAIN, timeouts, connection reset/refused, service transient HTTP codes
      const msg = String(err?.message || "");
      const code = String(err?.code || "");
      const status = Number(err?.statusCode || err?.status || 0);

      const isTransient =
        code === "EAI_AGAIN" ||
        /getaddrinfo EAI_AGAIN/i.test(msg) ||
        /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN/i.test(code + msg) ||
        [429, 502, 503, 504, 408].includes(status);

      if (!isTransient || attempt === retries - 1) {
        throw err;
      }

      // exponential backoff with jitter
      const exp = Math.min(maxMs, Math.round(baseMs * Math.pow(factor, attempt)));
      const jitter = Math.floor(Math.random() * Math.max(100, baseMs));
      const delay = exp + jitter;
      await new Promise((r) => setTimeout(r, delay));
      // loop and retry
    }
  }
  // unreachable
  throw new Error("retryWithBackoff: exhausted retries");
}


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
  async acquireSlot(limit = 99, maxRetries = 5): Promise<boolean> {
    await this.ensureTable();
    const pk = "copy";
    const rk = "counter";
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        // Read entity if exists
        //const entity = await this.client.getEntity<{ count: number }>(pk, rk).catch(() => undefined);

        // Acquire slot: replace direct calls with retry wrapper
        const entity = await retryWithBackoff(async () => {
          try {
            return await this.client.getEntity<{ count: number }>(pk, rk);
          } catch (e: any) {
            // keep same behaviour for 404: return undefined so calling code handles creation
            if (e?.statusCode === 404) return undefined;
            throw e;
          }
        });

        if (!entity) {
          // create entity with count = 1 if limit >= 1
          const init = { partitionKey: pk, rowKey: rk, count: 1 };
          if (limit < 1) return false;

          try {
            //await this.client.createEntity(init);
            await retryWithBackoff(() => this.client.createEntity(init));
            return true;
          } catch (createErr: any) {
            // If another instance created it concurrently, ignore and retry the loop to read+update
            if (createErr.statusCode === 409 || /EntityAlreadyExists/i.test(createErr.message)) {
              // small backoff then continue retry loop
              await this.backoff(attempt);
              continue;
            }
            throw createErr;
          }
        }

        const count = (entity as any).count ?? 0;
        if (count >= limit) return false;
        // optimistic update using ETag
        (entity as any).count = count + 1;
        //await this.client.updateEntity(entity as any, "Replace", { etag: (entity as any).etag,  matchCondition: "IfNotModified" });
        //await this.client.updateEntity(entity as any, "Replace", { etag: (entity as any).etag });
        await retryWithBackoff(() => this.client.updateEntity(entity as any, "Replace", { etag: (entity as any).etag }));

        return true;
      } catch (err: any) {
        // If ETag conflict, retry
        if (/Precondition Failed|412|UpdateConditionNotSatisfied/i.test(err.message) || err.statusCode === 412) {
          await this.backoff(attempt);
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
        /*
        const entity = await this.client.getEntity<{ count: number }>(pk, rk);
        const count = (entity as any).count ?? 0;
        const newCount = Math.max(0, count - 1);
        (entity as any).count = newCount;
        //await this.client.updateEntity(entity as any, "Replace", { etag: (entity as any).etag, matchCondition: "IfNotModified" });
        await this.client.updateEntity(entity as any, "Replace", { etag: (entity as any).etag });
        */
        await retryWithBackoff(async () => {
          const entity = await this.client.getEntity<{ count: number }>(pk, rk);
          const count = (entity as any).count ?? 0;
          (entity as any).count = Math.max(0, count - 1);
          await this.client.updateEntity(entity as any, "Replace", { etag: (entity as any).etag });
        });

        return;
      } catch (err: any) {
        if (/Precondition Failed|412|UpdateConditionNotSatisfied/i.test(err.message) || err.statusCode === 412) {
          await this.backoff(attempt);
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

  private async backoff(attempt: number) {
    const base = 25; // ms
    const jitter = Math.floor(Math.random() * 50);
    await new Promise(r => setTimeout(r, Math.min(2000, base * Math.pow(2, attempt)) + jitter));
  }
}