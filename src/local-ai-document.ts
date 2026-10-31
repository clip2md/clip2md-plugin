import { parseDocument, isMap } from 'yaml';
import { sha256 } from './saved-sync-proof';
export class LocalAIConflict extends Error {
}
interface Identity {
    taskId: number;
    inputId: string;
    titleFields: Record<string, string>;
}
const metadataPattern = /<!-- clip2md-desktop:v1:([^\n]+) -->/g;
const header = /^(\uFEFF?---\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/;
export async function localSlot(kind: 'ai' | 'source' | 'title', taskId: number, index: number, body: string): Promise<string> {
    if (/<!--\s*\/?clip2md-(?:ai|source|title|desktop)/.test(body))
        throw new LocalAIConflict('内容含保留的区域标记');
    const id = `${taskId}:${index}`;
    return `<!-- clip2md-${kind}:v1:${id}:${await sha256(body)} -->${body}<!-- /clip2md-${kind}:${id} -->`;
}
// Rendering is synchronous; body hashes are finalized before any Vault write.
export function slot(kind: 'ai' | 'source' | 'title', taskId: number, index: number, body: string): string {
    if (/<!--\s*\/?clip2md-(?:ai|source|title|desktop)/.test(body))
        throw new LocalAIConflict('内容含保留的区域标记');
    const id = `${taskId}:${index}`;
    return `<!-- clip2md-${kind}:v1:${id}:pending -->${body}<!-- /clip2md-${kind}:${id} -->`;
}
export async function finalizeSlots(content: string): Promise<string> {
    const matches = [...content.matchAll(/<!-- clip2md-(ai|source|title):v1:(\d+:\d+):pending -->([\s\S]*?)<!-- \/clip2md-\1:\2 -->/g)];
    for (const m of matches) {
        const hash = await sha256(m[3]);
        content = content.replace(m[0], () => m[0].replace(':pending -->', `:${hash} -->`));
    }
    return content;
}
function regions(content: string, id: number) {
    const pattern = new RegExp(`<!-- clip2md-(ai|source|title):v1:(${id}:\\d+):([a-f0-9]{64}) -->([\\s\\S]*?)<!-- /clip2md-\\1:\\2 -->`, 'g');
    const result = [...content.matchAll(pattern)];
    const starts = [...content.matchAll(new RegExp(`<!-- clip2md-(?:ai|source|title):v1:${id}:`, 'g'))].length;
    const ends = [...content.matchAll(new RegExp(`<!-- /clip2md-(?:ai|source|title):${id}:`, 'g'))].length;
    if (starts !== result.length || ends !== result.length)
        throw new LocalAIConflict('桌面区域边界缺失或损坏');
    const keys = result.map(m => `${m[1]}:${m[2]}`);
    if (new Set(keys).size !== keys.length)
        throw new LocalAIConflict('桌面区域标记重复');
    return result;
}
export async function localSourceChanged(content: string, taskId: number): Promise<boolean> {
    const sources = regions(content, taskId).filter(m => m[1] === 'source');
    for (const source of sources)
        if (await sha256(source[4]) !== source[3])
            return true;
    return sources.length === 0;
}
async function titleHashes(content: string, fields: string[]): Promise<Record<string, string>> {
    const match = header.exec(content);
    if (!match)
        return {};
    const doc = parseDocument(match[2]);
    if (doc.errors.length || !isMap(doc.contents))
        throw new LocalAIConflict('笔记属性 YAML 无效');
    const result: Record<string, string> = {};
    for (const field of fields)
        if (doc.has(field))
            result[field] = await sha256(JSON.stringify(doc.get(field)));
    return result;
}
export async function identifyLocalAI(content: string, taskId: number, inputId: string, fields: string[]): Promise<string> {
    content = await finalizeSlots(content);
    const identity: Identity = { taskId, inputId, titleFields: await titleHashes(content, fields) };
    return content + `\n<!-- clip2md-desktop:v1:${encodeURIComponent(JSON.stringify(identity))} -->`;
}
/** Only managed AI occurrences and untouched AI properties are replaced. Source bytes never change. */
export async function updateLocalAI(before: string, rendered: string, taskId: number, inputId: string, fields: string[], fallback?: {
    ai: string;
    title: string;
}): Promise<string> {
    const identities = [...before.matchAll(metadataPattern)];
    if (identities.length !== 1)
        throw new LocalAIConflict('历史笔记缺少可信的分区，请查看差异并确认迁移');
    const identity = JSON.parse(decodeURIComponent(identities[0][1])) as Identity;
    if (identity.taskId !== taskId)
        throw new LocalAIConflict('本地笔记任务身份不匹配');
    const after = await finalizeSlots(rendered), oldRegions = regions(before, taskId), newRegions = regions(after, taskId);
    if (!oldRegions.length)
        throw new LocalAIConflict('本地分区不存在');
    let result = before;
    for (const m of oldRegions.filter(m => m[1] !== 'source')) {
        if (await sha256(m[4]) !== m[3])
            throw new LocalAIConflict('智能内容已被用户修改，请先查看差异');
        let replacement = newRegions.find(n => n[1] === m[1] && n[2] === m[2]);
        if (m[2].endsWith(':999') && fallback) {
            const value = m[1] === 'title' ? fallback.title : fallback.ai;
            result = result.replace(m[0], () => slot(m[1] as 'title' | 'ai', taskId, 999, value));
            continue;
        }
        if (!replacement)
            throw new LocalAIConflict('模板布局已变化，请查看差异');
        result = result.replace(m[0], () => replacement[0]);
    }
    if (!oldRegions.some(m => m[2].endsWith(':999')) && newRegions.some(n => n[1] !== 'source' && !oldRegions.some(m => m[1] === n[1] && m[2] === n[2])))
        throw new LocalAIConflict('模板新增了智能内容位置，请确认迁移');
    const oldHeader = header.exec(result), newHeader = header.exec(after);
    if (oldHeader && newHeader) {
        const current = parseDocument(oldHeader[2]), incoming = parseDocument(newHeader[2]);
        if (current.errors.length || incoming.errors.length)
            throw new LocalAIConflict('笔记属性 YAML 无效');
        for (const field of fields) {
            if (!(field in identity.titleFields))
                continue;
            if (await sha256(JSON.stringify(current.get(field))) !== identity.titleFields[field])
                throw new LocalAIConflict('智能标题属性已被用户修改');
            current.set(field, incoming.get(field));
        }
        result = oldHeader[1] + current.toString().trimEnd() + oldHeader[3] + result.slice(oldHeader[0].length);
    }
    const next: Identity = { taskId, inputId, titleFields: await titleHashes(result, fields) };
    result = await finalizeSlots(result);
    return result.replace(identities[0][0], () => `<!-- clip2md-desktop:v1:${encodeURIComponent(JSON.stringify(next))} -->`);
}
