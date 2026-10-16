import { Component, MarkdownRenderer, parseYaml, Setting } from 'obsidian';
import type BijiSyncPlugin from './main';
import { DEFAULT_DAILY_MERGE_FRONTMATTER_TEMPLATE, NEW_DEFAULT_FRONTMATTER_TEMPLATE } from './settings';

type TemplateKey = 'template' | 'frontmatterTemplate' | 'dailyMergeFrontmatterTemplate';
export interface NoteContentViewState {
    expanded?: boolean;
    target?: 'single' | 'daily';
    source?: boolean;
    undoBody?: string;
}
const VARIABLES: Record<string, string> = {
    content: '所选同步内容', note_content: '智能笔记', source_content: '原文',
    note_title: '笔记标题', title: '智能标题', source_title: '原始标题', source_title_or_title: '原标题（缺失时用智能标题）',
    display_title: '账号展示标题', source: '来源', source_date: '原文日期', date: '日期',
    created_at: '创建时间', created_date: '创建日期', duration: '时长', content_type: '内容类型',
    url: '原文链接', task_id: '任务 ID', tags: '标签', task_count: '任务数量', task_ids: '任务 ID 数组', tasks: '任务清单',
};
const BODY_KEYS = ['note_title', 'content', 'note_content', 'source_content', 'title', 'source_title', 'source_title_or_title', 'display_title', 'source', 'date', 'created_at', 'created_date', 'duration', 'content_type', 'url', 'task_id', 'tags'];
const PROPERTY_KEYS = ['note_title', 'title', 'source_title', 'source_title_or_title', 'display_title', 'source_date', 'created_at', 'source', 'duration', 'content_type', 'url', 'task_id', 'tags'];

/** A single owner for editor state, validation, and the final-note preview. */
export class NoteContentSettings {
    private root: HTMLElement;
    private details: HTMLDetailsElement;
    private preview: HTMLElement;
    private status: HTMLElement;
    private saveStatus: HTMLElement;
    private restore: HTMLButtonElement;
    private undo: HTMLButtonElement;
    private targetControl: HTMLSelectElement;
    private modeControl!: HTMLSelectElement;
    private editors = new Map<TemplateKey, HTMLTextAreaElement>();
    private propertySections = new Map<TemplateKey, HTMLElement>();
    private renderer: Component | null = null;
    private revision = 0;
    private saveRevision = 0;
    private timer: number | null = null;
    private disposed = false;

    constructor(private plugin: BijiSyncPlugin, container: HTMLElement, private state: NoteContentViewState) {
        this.root = this.el(container, 'div', '', 'clip2md-note-content');
        new Setting(this.root).setName('同步内容').setDesc('选择填入 {{content}} 的内容；笔记属性独立保留。')
            .addDropdown(dropdown => {
                dropdown.addOption('full', '完整内容').addOption('note', '仅智能笔记').addOption('source', '仅原文')
                    .setValue(this.plugin.settings.syncContentMode).onChange(value => {
                        if (!this.plugin.settings.template.includes('{{content}}')) return;
                        this.plugin.settings.syncContentMode = value as 'full' | 'note' | 'source';
                        this.changed();
                    });
                this.modeControl = dropdown.selectEl;
            });
        this.status = this.el(this.root, 'p', '', 'setting-item-description');
        this.status.setAttribute('aria-live', 'polite');
        const actions = this.el(this.root, 'div', '', 'clip2md-content-actions');
        this.restore = this.button(actions, '恢复标准正文', () => {
            this.state.undoBody = this.plugin.settings.template;
            this.setTemplate('template', '{{content}}');
        });
        this.undo = this.button(actions, '撤销恢复', () => {
            if (this.state.undoBody === undefined) return;
            const value = this.state.undoBody;
            this.state.undoBody = undefined;
            this.setTemplate('template', value);
        });
        new Setting(this.root).setName('消息按日合并')
            .setDesc('仅微信、QQ、邮件按日合并，其他内容仍生成单篇笔记。')
            .addDropdown(dropdown => dropdown.addOption('none', '关闭').addOption('daily', '按日合并')
                .setValue(this.plugin.settings.mergeMode).onChange(value => {
                    this.plugin.settings.mergeMode = value === 'daily' ? 'daily' : 'none';
                    this.state.target = value === 'daily' ? 'daily' : 'single';
                    this.changed();
                }));
        this.state.target ??= this.plugin.settings.mergeMode === 'daily' ? 'daily' : 'single';
        new Setting(this.root).setName('编辑和预览对象').addDropdown(dropdown => {
            dropdown.addOption('single', '单篇笔记').addOption('daily', '按日合并')
                .setValue(this.state.target!).onChange(value => {
                    this.state.target = value === 'daily' ? 'daily' : 'single'; this.refresh();
                });
            this.targetControl = dropdown.selectEl;
        });
        this.details = this.el(this.root, 'details', '', 'clip2md-content-custom');
        this.details.open = !!state.expanded;
        this.el(this.details, 'summary', '自定义模板');
        this.details.addEventListener('toggle', () => { this.state.expanded = this.details.open; });
        this.editor('frontmatterTemplate', '笔记属性', '单篇文件顶部的 YAML，默认包含 title、date、tags、url。留空沿用默认属性。', PROPERTY_KEYS);
        this.editor('dailyMergeFrontmatterTemplate', '合并文件属性', '文件级 YAML；任务清单放在 tasks: 的下一行。留空使用默认模板。', ['title', 'date', 'source', 'tags', 'task_count', 'task_ids', 'tasks']);
        this.editor('template', '正文布局', '属性之后的正文。{{content}} 跟随上方的同步内容选择。', BODY_KEYS);
        this.saveStatus = this.el(this.details, 'p', '修改自动保存', 'setting-item-description');
        this.saveStatus.setAttribute('role', 'status');
        new Setting(this.root).setName('最终笔记预览').addDropdown(dropdown => dropdown
            .addOption('note', '笔记效果').addOption('source', 'Markdown 源码')
            .setValue(state.source ? 'source' : 'note').onChange(value => {
                this.state.source = value === 'source'; this.refresh();
            }));
        this.el(this.root, 'p', '示例数据；模板修改在后续同步时生效。', 'setting-item-description');
        this.preview = this.el(this.root, 'div', '', 'clip2md-content-preview');
        this.refresh();
    }

    private el<K extends keyof HTMLElementTagNameMap>(parent: HTMLElement, tag: K, text = '', cls = ''): HTMLElementTagNameMap[K] {
        return parent.createEl(tag, { text, cls });
    }

    private button(parent: HTMLElement, title: string, action: () => void): HTMLButtonElement {
        const button = this.el(parent, 'button', title);
        button.type = 'button';
        button.addEventListener('click', action);
        return button;
    }

    private editor(key: TemplateKey, title: string, help: string, variables: string[]) {
        const section = this.el(this.details, 'div', '', 'clip2md-content-editor');
        if (key !== 'template') this.propertySections.set(key, section);
        let input!: HTMLTextAreaElement;
        const setting = new Setting(section).setName(title).setDesc(help).addTextArea(text => {
            input = text.inputEl;
            text.setValue(this.plugin.settings[key]);
        });
        setting.settingEl.classList.add('clip2md-template-setting');
        input.rows = key === 'template' ? 8 : 7;
        input.spellcheck = false;
        input.className = 'clip2md-template-editor';
        this.editors.set(key, input);
        input.addEventListener('input', () => {
            this.plugin.settings[key] = input.value;
            if (key === 'template') this.state.undoBody = undefined;
            this.changed();
        });
        const tools = this.el(section, 'details', '', 'clip2md-content-variables');
        this.el(tools, 'summary', '插入变量');
        const list = this.el(tools, 'div', '', 'clip2md-template-toolbar');
        for (const name of variables) {
            const token = `{{${name}}}`;
            const button = this.button(list, `${VARIABLES[name]} ${token}`, () => {
                const start = input.selectionStart;
                const end = input.selectionEnd;
                input.value = input.value.slice(0, start) + token + input.value.slice(end);
                input.focus();
                input.setSelectionRange(start + token.length, start + token.length);
                this.plugin.settings[key] = input.value;
                if (key === 'template') this.state.undoBody = undefined;
                this.changed();
            });
            button.className = 'clip2md-chip-button';
            button.title = name === 'content' ? '根据上方选择插入完整内容、智能笔记或原文'
                : name === 'tasks' ? '含任务 ID、标题和已知链接的 YAML 清单'
                    : `插入${VARIABLES[name]}`;
        }
        this.button(section, key === 'template' ? '恢复标准正文' : '恢复默认属性', () => {
            if (key === 'template') this.state.undoBody = this.plugin.settings.template;
            this.setTemplate(key, key === 'template' ? '{{content}}'
                : key === 'frontmatterTemplate' ? NEW_DEFAULT_FRONTMATTER_TEMPLATE : DEFAULT_DAILY_MERGE_FRONTMATTER_TEMPLATE);
        });
    }

    private setTemplate(key: TemplateKey, value: string) {
        this.plugin.settings[key] = value;
        const editor = this.editors.get(key);
        if (editor) editor.value = value;
        this.changed();
    }

    private changed() {
        this.updateControls();
        const save = ++this.saveRevision;
        this.saveStatus.textContent = '保存中…';
        void this.plugin.saveSettings().then(() => {
            if (!this.disposed && save === this.saveRevision) this.saveStatus.textContent = '已保存';
        }).catch(() => {
            if (!this.disposed && save === this.saveRevision) this.saveStatus.textContent = '保存失败，请修改后重试。';
        });
        this.plugin.timers.clearTimeout(this.timer);
        // Invalidate a slow Markdown render as soon as the input changes.
        this.revision++;
        this.renderer?.unload();
        this.renderer = null;
        this.timer = this.plugin.timers.setTimeout(() => this.refresh(), 300, 'settings-ui');
    }

    private updateControls() {
        const custom = !this.plugin.settings.template.includes('{{content}}');
        this.modeControl.disabled = custom;
        this.modeControl.value = this.plugin.settings.syncContentMode;
        this.status.textContent = custom ? '自定义正文：正文由下方模板决定。恢复标准正文后可选择同步内容。'
            : '所选内容填入正文中的 {{content}}，笔记属性独立保留。';
        this.restore.hidden = !custom;
        this.undo.hidden = this.state.undoBody === undefined;
        if (this.plugin.settings.mergeMode !== 'daily') this.state.target = 'single';
        this.targetControl.value = this.state.target || 'single';
        this.targetControl.closest<HTMLElement>('.setting-item')!.hidden = this.plugin.settings.mergeMode !== 'daily';
        for (const [key, section] of this.propertySections) {
            section.hidden = (key === 'dailyMergeFrontmatterTemplate') !== (this.state.target === 'daily');
        }
    }

    private focusEditor(key: TemplateKey) {
        this.details.open = true;
        this.state.expanded = true;
        this.editors.get(key)?.focus();
    }

    refreshPreview() { this.refresh(); }

    private refresh() {
        if (this.disposed) return;
        this.updateControls();
        const revision = ++this.revision;
        this.renderer?.unload();
        this.renderer = null;
        this.preview.replaceChildren();
        const validation = this.plugin.validateTemplate(this.plugin.settings.template);
        if (!validation.valid) {
            this.el(this.preview, 'p', validation.message, 'clip2md-template-error').setAttribute('role', 'alert');
            this.button(this.preview, '定位到正文模板', () => this.focusEditor('template'));
            return;
        }
        const markdown = this.plugin.renderTemplatePreview(this.state.target || 'single');
        const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
        let properties: Record<string, unknown> = {};
        let yamlError = '';
        try {
            if (!match) throw new Error('属性模板需以 --- 开始并以 --- 结束。');
            const parsed: unknown = parseYaml(match[1]);
            if (parsed !== null && (typeof parsed !== 'object' || Array.isArray(parsed))) throw new Error('属性需为 YAML 键值字段。');
            properties = (parsed || {}) as Record<string, unknown>;
        } catch (error) { yamlError = error instanceof Error ? error.message : String(error); }
        if (yamlError) {
            this.el(this.preview, 'p', `属性 YAML 无效：${yamlError}`, 'clip2md-template-error').setAttribute('role', 'alert');
            this.button(this.preview, '定位到属性模板', () => this.focusEditor(this.state.target === 'daily' ? 'dailyMergeFrontmatterTemplate' : 'frontmatterTemplate'));
        }
        if (this.state.source) {
            this.el(this.el(this.preview, 'pre'), 'code', markdown);
            return;
        }
        if (yamlError) return;
        const table = this.el(this.preview, 'dl', '', 'clip2md-note-properties');
        for (const [key, value] of Object.entries(properties)) {
            this.el(table, 'dt', key);
            this.el(table, 'dd', typeof value === 'string' ? value : JSON.stringify(value));
        }
        const body = markdown.slice(match![0].length);
        const target = this.preview.createDiv({ cls: 'markdown-rendered clip2md-note-body' });
        // Render off-screen; only the latest completed preview is attached.
        target.remove();
        const component = new Component();
        component.load();
        this.renderer = component;
        void MarkdownRenderer.render(this.plugin.app, body, target, '', component).then(() => {
            if (!this.disposed && revision === this.revision) this.preview.appendChild(target);
        }).catch(() => {
            if (!this.disposed && revision === this.revision) this.el(this.preview, 'p', '笔记效果加载失败，请切换 Markdown 源码查看。');
        });
    }

    dispose() {
        this.disposed = true;
        this.revision++;
        this.plugin.timers.clearTimeout(this.timer);
        this.renderer?.unload();
        this.renderer = null;
    }
}
