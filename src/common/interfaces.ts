// interfaces.ts

export interface SnapshotSource {
    subscriptionId: string;
    resourceGroup: string;
    location: string;
    vmId: string;
    vmName: string;
    vmSize: string;
    diskId: string;
    diskName: string;
    diskSizeGB: string;
}

export interface Snapshot {
    id: string;
    name: string;
    location: string;
    resourceGroup: string;
    subscriptionId: string;
}

export interface SnapshotToPurge {
    id: string;
    name: string;
    location: string;
    resourceGroup: string;
    subscriptionId: string;
    sourceResourceId: string;
    sourceResourceName: string;
    timeCreated: string;
}

export interface SnapshotCopy {
    jobId: string;
    sourceVmId: string;
    sourceDiskId: string;
    primarySnapshot: Snapshot;
    secondaryLocation: string;
    attempt: number;
}

export interface SnapshotControl {
    jobId: string;
    sourceVmId: string;
    sourceDiskId: string;
    primarySnapshotId: string;
    secondarySnapshotId: string;
    primaryLocation: string;
    secondaryLocation: string;
}

export interface SnapshotCopyControl {
    control: SnapshotControl;
    snapshot: Snapshot;
}

export interface SnapshotPurgeControl {
    source: SnapshotControl;
    snapshotsNameToPurge: string[];
}

export interface SnapshotBulkPurgeSource {
    control: SnapshotControl;
    type: 'primary' | 'secondary';
}

export interface JobLogEntry {
    jobId: string;
    jobOperation: 'Start' | 'Snapshot Create' | 'Snapshot Create End' | 'Snapshot Copy Start' | 'Snapshot Copy End' | 'Snapshot Purge Start' | 'Snapshot Purge End' | 'Error';
    jobStatus: 'Snapshot In Progress' | 'Snapshot Completed' | 'Snapshot Failed' | 'Purge In Progress' | 'Purge Completed' | 'Purge Failed';
    jobType: 'Snapshot' | 'Purge';
    message: string;
    sourceVmId: string;
    sourceDiskId: string;
    primarySnapshotId?: string;
    secondarySnapshotId?: string;
    primaryLocation?: string;
    secondaryLocation?: string;
}