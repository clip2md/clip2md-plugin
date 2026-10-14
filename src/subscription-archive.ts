import { TFile, type App } from 'obsidian';
import { parseDocument } from 'yaml';
import { documentMetadata, ensureArchiveFolder, managedRegion, region, verifiedRegion, type ManagedMetadata, SubscriptionConflict, backupSubscription } from './subscription-document';
import { archiveConfig, bloggerName, type ArchiveConfig, type SubscriptionContext, type SubscriptionDeviceState } from './subscriptions';

export interface LocalSubscriptionNote { file: TFile; metadata: ManagedMetadata; }
export interface IndexConflict { id: number; path: string; current: string; proposed: string; }
export function safeArchiveSegment(value: string): string {
    const segment = value.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim().slice(0, 120);
    return !segment || segment === '.' || segment === '..' ? '未知' : segment;
}
export function archiveFolder(context: SubscriptionContext, config: ArchiveConfig): string {
    const template = config.bloggers[String(context.subscription_id)]?.folder || config.folderTemplate;
    return template.replace(/\{\{(platform|blogger_name|blogger_id|subscription_id)\}\}/g, (_, key) => ({
        platform: safeArchiveSegment(context.platform || ''), blogger_name: safeArchiveSegment(bloggerName(context)),
        blogger_id: safeArchiveSegment(context.blogger_id || ''), subscription_id: String(context.subscription_id),
    }[key as 'platform'])).replace(/\\/g, '/').split('/').filter(p => p && p !== '.' && p !== '..').join('/');
}
export function collidingSubscriptions(contexts: SubscriptionContext[], config: ArchiveConfig): number[] {
    const groups = new Map<string, Set<number>>();
    for (const c of contexts) {
        if (config.bloggers[String(c.subscription_id)]?.folder) continue;
        const path = archiveFolder(c, config).toLocaleLowerCase();
        const ids = groups.get(path) || new Set<number>(); ids.add(c.subscription_id!); groups.set(path, ids);
    }
    return [...groups.values()].filter(ids => ids.size > 1).flatMap(ids => [...ids]);
}

export async function scanSubscriptionNotes(app: App, accountId: string): Promise<LocalSubscriptionNote[]> {
    const notes: LocalSubscriptionNote[] = [];
    for (const file of app.vault.getMarkdownFiles()) {
        if (file.path.startsWith('.clip2md-subscription-backups/')) continue;
        const metadata = documentMetadata(await app.vault.cachedRead(file));
        if (metadata?.account_id === accountId) notes.push({ file, metadata });
    }
    return notes;
}
function localLink(app: App, note: LocalSubscriptionNote, sourcePath: string): string {
    return app.fileManager.generateMarkdownLink(note.file, sourcePath, undefined, note.metadata.title || note.file.basename);
}
function sameWork(a: ManagedMetadata, b: ManagedMetadata): boolean {
    return a.subscription_id === b.subscription_id && a.work_id === b.work_id;
}
function linksFor(app: App, note: LocalSubscriptionNote, notes: LocalSubscriptionNote[]): string {
    const c = note.metadata;
    const lines: string[] = ['## 本地关联', ''];
    if (c.kind === 'daily_report') {
        for (const ref of c.related_works || []) {
            const target = notes.find(n => n.metadata.kind === 'work' && (n.metadata.task_id === ref.task_id
                || (n.metadata.subscription_id === ref.subscription_id && n.metadata.work_id === ref.work_id)));
            if (target) lines.push(`- ${localLink(app, target, note.file.path)}`);
        }
    } else {
        const related = notes.filter(n => n !== note && sameWork(c, n.metadata)
            && n.metadata.kind !== c.kind);
        for (const target of related) lines.push(`- ${localLink(app, target, note.file.path)}`);
        if (c.kind === 'comment_supplement' && !related.length && /^https?:\/\//.test(c.original_url || '')) {
            lines.push(`- [原作品](${c.original_url})`);
        }
        lines.push(`- [网页管理](https://clip2.md/app/bloggers${c.work_record_id ? `?work=${c.work_record_id}` : ''})`);
    }
    return lines.join('\n');
}
export async function rebuildSubscriptionArchive(app: App, accountId: string, config: ArchiveConfig,
    state: SubscriptionDeviceState, map: Record<number, string>, indexReplacements = new Map<number, string>()
): Promise<{ notes: LocalSubscriptionNote[]; errors: string[]; indexConflicts: IndexConflict[] }> {
    const notes = await scanSubscriptionNotes(app, accountId);
    const errors: string[] = [];
    const indexConflicts: IndexConflict[] = [];
    const counts = new Map<number, number>();
    for (const n of notes) counts.set(n.metadata.task_id, (counts.get(n.metadata.task_id) || 0) + 1);
    for (const note of notes) {
        const id = note.metadata.task_id;
        if (counts.get(id)! > 1) {
            state.statuses[id] = { status: 'conflict', message: '同一任务存在多个本地文件，请保留一个后重试' };
            errors.push(`${note.file.path}：任务重复`); continue;
        }
        map[id] = note.file.path;
        try {
            const content = await app.vault.read(note.file);
            await verifiedRegion(content, 'cloud', id);
            const next = await managedRegion('links', id, linksFor(app, note, notes));
            const currentRegion = region(content, 'links', id);
            // Obsidian may rewrite generated links after a rename. Only repair a
            // checksum when the entire body equals our freshly generated body.
            const old = currentRegion && currentRegion.body === region(next, 'links', id)!.body
                ? currentRegion.full : await verifiedRegion(content, 'links', id);
            if (next !== old) await app.vault.process(note.file, current => {
                if (region(current, 'links', id)?.full !== old) throw new SubscriptionConflict('关联区域正在被编辑');
                return current.replace(old, () => next);
            });
        } catch (error) {
            state.statuses[id] = { status: 'conflict', message: String(error) };
            errors.push(`${note.file.path}：${String(error)}`);
        }
    }
    if (!config.enabled || !config.indexEnabled) return { notes, errors, indexConflicts };
    const indexes = new Map<number, TFile>();
    const duplicateIndexes = new Set<number>();
    const indexNames = new Map<number, string>();
    for (const file of app.vault.getMarkdownFiles()) {
        if (file.path.startsWith('.clip2md-subscription-backups/')) continue;
        const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(await app.vault.cachedRead(file));
        if (!match) continue;
        try {
            const meta = parseDocument(match[1]).toJS()?.clip2md_index;
            if (meta?.account_id === accountId && Number.isSafeInteger(meta.subscription_id)) {
                if (indexes.has(meta.subscription_id)) { duplicateIndexes.add(meta.subscription_id); throw new Error('重复的博主索引页'); }
                indexes.set(meta.subscription_id, file);
                indexNames.set(meta.subscription_id, meta.blogger_name || `博主 #${meta.subscription_id}`);
            }
        } catch (error) { errors.push(`${file.path}：${String(error)}`); }
    }
    const groups = new Map<number, LocalSubscriptionNote[]>();
    for (const id of indexes.keys()) groups.set(id, []);
    for (const n of notes.filter(n => n.metadata.kind === 'work' && counts.get(n.metadata.task_id) === 1)) {
        const group = groups.get(n.metadata.subscription_id!) || []; group.push(n); groups.set(n.metadata.subscription_id!, group);
    }
    for (const [id, works] of groups) try {
        if (duplicateIndexes.has(id)) continue;
        const c = works[0]?.metadata;
        let file = indexes.get(id);
        let path = file?.path || `${works[0].file.path.split('/').slice(0, -1).join('/')}/_博主索引.md`;
        if (!file && app.vault.getAbstractFileByPath(path)) path = path.replace(/\.md$/, `-${id}.md`);
        if (!file && app.vault.getAbstractFileByPath(path)) throw new Error(`索引路径被占用：${path}`);
        works.sort((a, b) => {
            const at = Date.parse(a.metadata.published_kind === 'exact' && a.metadata.published_at || a.metadata.first_discovered_at || '') || 0;
            const bt = Date.parse(b.metadata.published_kind === 'exact' && b.metadata.published_at || b.metadata.first_discovered_at || '') || 0;
            return bt - at || b.metadata.task_id - a.metadata.task_id;
        });
        const name = c ? bloggerName(c) : indexNames.get(id) || `博主 #${id}`;
        const lines = [`# ${name.replace(/[\r\n]/g, ' ')}`, '', '## 已同步作品', ''];
        for (const w of works) {
            const m = w.metadata;
            const date = m.published_kind === 'exact' && m.published_at ? m.published_at
                : `${m.first_discovered_at || '未知'}（发现时间；发布时间${m.published_text ? `：${m.published_text}` : '未知'}）`;
            lines.push(`- ${localLink(app, w, path)} · ${date}`);
            for (const comment of notes.filter(n => n.metadata.kind === 'comment_supplement' && sameWork(m, n.metadata))) {
                lines.push(`  - ${localLink(app, comment, path)}`);
            }
        }
        const body = await managedRegion('index', id, lines.join('\n'));
        if (!file) {
            await ensureArchiveFolder(app.vault, path.split('/').slice(0, -1).join('/'));
            const yaml = parseDocument(''); yaml.set('clip2md_index', { account_id: accountId, subscription_id: id, blogger_name: name });
            file = await app.vault.create(path, `---\n${yaml.toString()}---\n\n${body}\n\n## 我的整理\n\n`);
        } else {
            const before = await app.vault.read(file);
            try {
                const authorization = indexReplacements.get(id);
                if (authorization !== undefined) {
                    if (authorization !== before) throw new SubscriptionConflict('确认后索引已变化，请重新查看差异');
                    await backupSubscription(app.vault, id, before);
                    await app.vault.process(file, current => {
                        if (current !== before) throw new SubscriptionConflict('索引正在被编辑');
                        const r = region(current, 'index', id);
                        return r ? current.replace(r.full, () => body) : current.replace(
                            new RegExp(`<!-- /?clip2md-index(?::v1)?:${id}[^>]*-->`, 'g'), '') + '\n\n' + body;
                    });
                    indexReplacements.delete(id);
                } else {
                    const currentRegion = region(before, 'index', id);
                    const old = currentRegion && currentRegion.body === region(body, 'index', id)!.body
                        ? currentRegion.full : await verifiedRegion(before, 'index', id);
                    if (!state.keptIndexIds?.includes(id) && old !== body) await app.vault.process(file, current => {
                        if (region(current, 'index', id)?.full !== old) throw new SubscriptionConflict('索引自动区域正在被编辑');
                        return current.replace(old, () => body);
                    });
                }
            } catch (error) { indexConflicts.push({ id, path, current: before, proposed: body }); throw error; }
        }
    } catch (error) { errors.push(`博主 #${id} 索引：${String(error)}`); }
    return { notes, errors, indexConflicts };
}
