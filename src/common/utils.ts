
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