export function sanitizeConfigForBackup(data: unknown): Record<string, unknown> {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return {};
    }

    const { apiKey: _apiKey, ...safeData } = data as Record<string, unknown>;
    return safeData;
}
