/** Format user-facing timestamps in China Standard Time (UTC+8). */
export function formatBeijingDateTime(value: string | Date | number): string {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) return String(value);
    const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
    const pad = (part: number) => String(part).padStart(2, '0');
    return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`;
}

export const nowBeijingDateTime = (): string => formatBeijingDateTime(new Date());
