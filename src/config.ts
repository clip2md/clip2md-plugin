/**
 * Obsidian always talks to the hosted Clip2MD service.  Keeping these values
 * in one module prevents a stale local-development URL from leaking into a
 * packaged plugin.
 */
export const CLIP2MD_API_BASE_URL = 'https://api.clip2md.cn/api/v1';
export const CLIP2MD_APP_URL = 'https://clip2.md';
