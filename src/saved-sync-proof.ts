import { TFile, type Vault } from 'obsidian';

export interface SavedSyncProof {
    scope?: 'subscription-v1';
    filepath: string;
    contentHash: string;
    images: Array<{ path: string; hash: string }>;
}

export async function sha256(data: string | ArrayBuffer): Promise<string> {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function savedTaskContent(content: string, taskId: number, scope?: 'subscription-v1'): string {
    if (scope === 'subscription-v1') {
        if ((content.match(new RegExp(`<!-- clip2md-cloud:v1:${taskId}:`, 'g')) || []).length !== 1
            || (content.match(new RegExp(`<!-- /clip2md-cloud:${taskId} -->`, 'g')) || []).length !== 1) return '';
        const matches = [...content.matchAll(new RegExp(`<!-- clip2md-cloud:v1:${taskId}:[a-f0-9]{64} -->\\n[\\s\\S]*?\\n<!-- /clip2md-cloud:${taskId} -->`, 'g'))];
        return matches.length === 1 ? matches[0][0] : '';
    }
    if (!content.includes('<!-- clip2md-task-start:')) return content;
    const start = `<!-- clip2md-task-start:${taskId} -->`;
    const end = `<!-- clip2md-task-end:${taskId} -->`;
    const offset = content.indexOf(start);
    const endOffset = content.indexOf(end, offset + start.length);
    return offset >= 0 && endOffset >= 0 ? content.slice(offset, endOffset + end.length) : '';
}

export function resolveImagePath(notePath: string, reference: string): string | null {
    let decoded: string;
    try { decoded = decodeURIComponent(reference.replace(/^<|>$/g, '')); } catch { return null; }
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(decoded)) return null;
    const parts = decoded.startsWith('/') ? [] : notePath.split('/').slice(0, -1);
    for (const part of decoded.split('/')) {
        if (!part || part === '.') continue;
        if (part === '..') {
            if (!parts.length) return null;
            parts.pop();
        } else parts.push(part);
    }
    return parts.join('/');
}

export async function verifySavedSyncProof(vault: Vault, taskId: number, proof: SavedSyncProof): Promise<boolean> {
    const file = vault.getAbstractFileByPath(proof.filepath);
    if (!(file instanceof TFile)) return false;
    const content = savedTaskContent(await vault.read(file), taskId, proof.scope);
    if (!content || await sha256(content) !== proof.contentHash) return false;
    for (const image of proof.images) {
        const imageFile = vault.getAbstractFileByPath(image.path);
        if (!(imageFile instanceof TFile)) return false;
        const bytes = await vault.readBinary(imageFile);
        if (!bytes.byteLength || await sha256(bytes) !== image.hash) return false;
    }
    return true;
}
