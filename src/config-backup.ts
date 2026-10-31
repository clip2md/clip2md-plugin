const SHAREABLE_KEYS = [
    'subscriptionAccounts',
    'settingsSchemaVersion', 'syncInterval', 'syncOnStart', 'preventReimportAfterLocalRemoval',
    'targetFolder', 'commentFolder', 'sourcePropertiesTemplateInitialized', 'filenameTemplate', 'filenameDateFormat', 'template', 'frontmatterTemplate',
    'dailyMergeFrontmatterTemplate', 'titleMode', 'customTitleTemplate',
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
