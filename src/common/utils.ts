
// Generate GUID
// This function generates a random GUID (Globally Unique Identifier) in the format xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
export function generateGuid(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

export function formatDateYYYYMMDDTHHMMSS(date: Date): string {
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}T${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export function formatDateYYYYMMDDTHHMM(date: Date): string {
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}T${pad(date.getHours())}${pad(date.getMinutes())}`;
}

export function formatDateYYYYMMDD(date: Date): string {
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

export function extractResourceGroupFromResourceId(resourceId: string): string | null {
    if (!resourceId) {
        return null;
    }       
    // Split the resource ID by '/' and find the resource group
    const parts = resourceId.split("/");
    const resourceGroupIndex = parts.indexOf("resourceGroups");
    const resourceGroup = resourceGroupIndex !== -1 ? parts[resourceGroupIndex + 1] : null;
    return resourceGroup;
}

export function extractSubscriptionIdFromResourceId(resourceId: string): string | null {
    if (!resourceId) {
        return null;
    }
    // Split the resource ID by '/' and find the subscription ID
    const parts = resourceId.split("/");
    const subscriptionIndex = parts.indexOf("subscriptions");
    const subscriptionId = subscriptionIndex !== -1 ? parts[subscriptionIndex + 1] : null;
    return subscriptionId;
}

export function extractDiskNameFromDiskId(diskId: string): string | null {
    if (!diskId) {
        return null;
    }
    // Split the disk ID by '/' and find the disk name
    const parts = diskId.split("/");
    const diskNameIndex = parts.indexOf("disks");
    const diskName = diskNameIndex !== -1 ? parts[diskNameIndex + 1] : null;
    return diskName;
}

export function extractVmNameFromResourceId(vmId: string): string | null {
    if (!vmId) {
        return null;
    }
    // Split the VM ID by '/' and find the VM name
    const parts = vmId.toLowerCase().split("/");
    const vmNameIndex = parts.indexOf("virtualmachines");
    const vmName = vmNameIndex !== -1 ? parts[vmNameIndex + 1] : null;
    return vmName;
}


export function extractSnapshotNameFromSnapshotId(snapshotId: string): string | null {
    if (!snapshotId) {
        return null;
    }
    // Split the snapshot ID by '/' and find the snapshot name
    const parts = snapshotId.split("/");
    const snapshotNameIndex = parts.indexOf("snapshots");
    const snapshotName = snapshotNameIndex !== -1 ? parts[snapshotNameIndex + 1] : null;
    return snapshotName;
}

// Helper: returns a random delay in seconds between minMinutes and maxMinutes (inclusive)
export const getRandomDelaySeconds = (minMinutes = 5, maxMinutes = 20): number => {
    const min = Math.ceil(minMinutes);
    const max = Math.floor(maxMinutes);
    const minutes = Math.floor(Math.random() * (max - min + 1)) + min;
    return minutes * 60;
};

/**
 * Return a random delay in seconds between scaledMin and scaledMax minutes.
 * - Applies exponential backoff based on `attempt` (multiplier = 2^(attempt-1)).
 * - Adds jitter by choosing a random minute value between scaledMin and scaledMax.
 * - Caps scaled values to `maxCapMinutes` (param) or to the env var SNAPSHOT_RETRY_MAX_DELAY_MINUTES, default 180.
 *
 * @param minMinutes base minimum (minutes)
 * @param maxMinutes base maximum (minutes)
 * @param attempt attempt number (1 => base delay; 2 => doubled; etc.)
 * @param maxCapMinutes optional maximum cap for minutes (overrides env var)
 * @returns delay in seconds
 */
export const getExponentialBackoffRandomDelaySeconds = (
    minMinutes = 5,
    maxMinutes = 20,
    attempt = 1,
    maxCapMinutes?: number
): number => {
    const envCap = process.env.SNAPSHOT_RETRY_MAX_DELAY_MINUTES ? Number.parseInt(process.env.SNAPSHOT_RETRY_MAX_DELAY_MINUTES) : undefined;
    const cap = (typeof maxCapMinutes === 'number' && Number.isFinite(maxCapMinutes))
        ? Math.max(1, Math.floor(maxCapMinutes))
        : (envCap && Number.isFinite(envCap) ? envCap : 180); // default cap 180 minutes

    const adjAttempt = Math.max(1, Math.floor(Number(attempt) || 1));
    const multiplier = Math.pow(2, adjAttempt - 1);

    // Scale and clamp
    let scaledMin = Math.max(1, Math.ceil(minMinutes * multiplier));
    let scaledMax = Math.max(scaledMin, Math.floor(maxMinutes * multiplier));

    scaledMin = Math.min(scaledMin, cap);
    scaledMax = Math.min(scaledMax, cap);

    if (scaledMax < scaledMin) scaledMax = scaledMin;

    const minutes = Math.floor(Math.random() * (scaledMax - scaledMin + 1)) + scaledMin;
    return minutes * 60;
};