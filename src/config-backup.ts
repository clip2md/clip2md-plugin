export function sanitizeConfigForBackup(data: unknown): Record<string, unknown> {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return {};
    }

    const { apiKey: _apiKey, pendingAcks: _pendingAcks, ...safeData } = data as Record<string, unknown>;
    // Signed receipts stay in data.json. A sanitized backup instead retries the
    // corresponding tasks after the user restores their API Key.
    if (Array.isArray(_pendingAcks)) {
        const pendingTaskIds = Array.isArray(safeData.pendingTaskIds)
            ? safeData.pendingTaskIds.filter(id => Number.isSafeInteger(id) && id > 0)
            : [];
        for (const item of _pendingAcks) {
            if (item && typeof item === 'object' && Number.isSafeInteger(item.taskId) && item.taskId > 0) {
                pendingTaskIds.push(item.taskId);
            }
        }
        safeData.pendingTaskIds = [...new Set(pendingTaskIds)];
    }
    return safeData;
}
