const SHAREABLE_KEYS = [
    'settingsSchemaVersion', 'syncInterval', 'syncOnStart', 'preventReimportAfterLocalRemoval',
    'targetFolder', 'filenameTemplate', 'filenameDateFormat', 'template', 'frontmatterTemplate',
    'syncContentMode', 'imageMode', 'imageFolder', 'mergeMode',
];

export function sanitizeConfigForBackup(data: unknown): Record<string, unknown> {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
    const source = data as Record<string, unknown>;
    const safe: Record<string, unknown> = {};
    for (const key of SHAREABLE_KEYS) {
        if (Object.prototype.hasOwnProperty.call(source, key)) safe[key] = source[key];
    }
    return safe;
}
