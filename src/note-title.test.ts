import { describe, expect, it } from 'vitest';
import { resolveNoteTitle, validateCustomTitle } from './note-title';
import type { BijiSyncSettings } from './settings';
import type { SyncTask } from './sync';
import BijiSyncPlugin from './main';
import { LEGACY_DEFAULT_FRONTMATTER_TEMPLATE, LEGACY_TAGGED_FRONTMATTER_TEMPLATE, DEFAULT_FRONTMATTER_TEMPLATE, NEW_DEFAULT_FILENAME_TEMPLATE, NEW_DEFAULT_FRONTMATTER_TEMPLATE } from './settings';
const task = { id: 42, title: '智能标题', source_title: '原标题', display_title: '网站标题', created_at: '2026-10-08T00:00:00Z', source_date: '2026-10-07' } as SyncTask;
const resolve = (settings: Partial<BijiSyncSettings>, overrides: Partial<SyncTask> = {}) => resolveNoteTitle(settings as BijiSyncSettings, { ...task, ...overrides }, '微信公众号', '2026-10-08');
describe('note title policy', () => {
    it('follows website preferences and progressively falls back', () => {
        expect(resolve({})).toBe('网站标题');
        expect(resolve({}, { display_title: null })).toBe('智能标题');
        expect(resolve({}, { display_title: null, title: null })).toBe('原标题');
        expect(resolve({}, { display_title: null, title: null, source_title: null })).toBe('untitled-42');
    });
    it('falls back when the selected title is missing', () => {
        expect(resolve({ titleMode: 'source' }, { source_title: null })).toBe('智能标题');
        expect(resolve({ titleMode: 'task' }, { title: null })).toBe('原标题');
    });
    it('supports a literal template and date/source variables with empty-result fallback', () => {
        expect(resolve({ titleMode: 'custom', customTitleTemplate: '{{source}} · {{created_date}} · {{task_id}}' })).toBe('微信公众号 · 2026-10-08 · 42');
        expect(resolve({ titleMode: 'custom', customTitleTemplate: '我的标题' })).toBe('我的标题');
        expect(resolve({ titleMode: 'custom', customTitleTemplate: '{{source_title}}' }, { source_title: null })).toBe('网站标题');
    });
    it.each(['{{content}}', '{{note_content}}', '{{source_content}}', '{{note_title}}', '{{unknown}}', 'a\nb'])('rejects unsafe title template %s', template => {
        expect(validateCustomTitle(template)).not.toBe('');
        expect(resolve({ titleMode: 'custom', customTitleTemplate: template })).toBe('网站标题');
    });
    it('migrates only exact built-in defaults and does not repeat migration after initial load', () => {
        const plugin = Object.create(BijiSyncPlugin.prototype) as BijiSyncPlugin;
        const normalize = (value: Record<string, unknown>) => plugin['normalizeSettings'](value);
        const migrated = normalize({ filenameTemplate: '{{created_date}}-{{title}}', frontmatterTemplate: DEFAULT_FRONTMATTER_TEMPLATE });
        expect(migrated).toMatchObject({ titleMode: 'website', customTitleTemplate: '', filenameTemplate: NEW_DEFAULT_FILENAME_TEMPLATE, frontmatterTemplate: NEW_DEFAULT_FRONTMATTER_TEMPLATE });
        const custom = normalize({ filenameTemplate: '自定义-{{title}}', frontmatterTemplate: '---\ntitle: "自定义"\n---' });
        expect(custom.filenameTemplate).toBe('自定义-{{title}}');
        expect(custom.frontmatterTemplate).toBe('---\ntitle: "自定义"\n---');
        const explicit = normalize({ ...migrated, filenameTemplate: '{{created_date}}-{{title}}', frontmatterTemplate: DEFAULT_FRONTMATTER_TEMPLATE });
        expect(explicit.filenameTemplate).toBe('{{created_date}}-{{title}}');
        expect(explicit.frontmatterTemplate).toBe(DEFAULT_FRONTMATTER_TEMPLATE);
    });
    it.each([LEGACY_TAGGED_FRONTMATTER_TEMPLATE, LEGACY_DEFAULT_FRONTMATTER_TEMPLATE])('fills missing built-in metadata fields while preserving an explicit title choice', template => {
        const plugin = Object.create(BijiSyncPlugin.prototype) as BijiSyncPlugin;
        const current = plugin['normalizeSettings']({ titleMode: 'source', frontmatterTemplate: template });
        expect(current.frontmatterTemplate).toBe(DEFAULT_FRONTMATTER_TEMPLATE);
        expect(current.frontmatterTemplate).toContain('title: "{{title}}"');
        const old = plugin['normalizeSettings']({ frontmatterTemplate: template });
        expect(old.frontmatterTemplate).toBe(NEW_DEFAULT_FRONTMATTER_TEMPLATE);
        const custom = `${template}\n# 自定义`;
        expect(plugin['normalizeSettings']({ frontmatterTemplate: custom }).frontmatterTemplate).toBe(custom);
    });

});
