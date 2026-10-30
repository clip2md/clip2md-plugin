import { BUILD_CHANNEL } from './build-channel';
import { parseDocument } from "yaml";
import { Events, Modal, Notice, Platform, Setting, TFile } from "obsidian";
import type BijiSyncPlugin from "./main";
import type { SyncTask } from "./sync";
import { applySourceProperties, readSourceProperties, sourcePropertyKeys } from './property-template';
import { documentMetadata } from './subscription-document';
import { projectProofContent, savedTaskContent, sha256 } from "./saved-sync-proof";
import {
  mergeLocalProperties,
  readLocalProperties,
  withLocalProperties,
} from "./local-properties";
import { renderLocalMedia } from "./desktop-variables";
import { hasTaskId } from './task-id';
import {
  BRIDGE_EVENTS,
  BRIDGE_VERSION,
  isTaskContext,
  validateProperties,
  type CompanionState,
  type HostBridge,
  type MetadataRequest,
  type MetadataResult,
  type TaskContext,
} from "./companion-protocol";
import { FavoriteLinkImporter } from './favorite-import';
const CONTEXT_KEY = "clip2md-companion-contexts-v1";
const OWNERS_KEY = "clip2md-companion-task-owners-v1";
const DISMISSED_KEY = "clip2md-companion-install-dismissed-v1";
/** Optional companion bridge. No Node/Electron or cloud credentials cross this interface. */
export class CompanionHost {
  private alive = true;
  private contexts: TaskContext[] = [];
  private owners: Record<number, string> = {};
  private companion: CompanionState | null = null;
  private lastScope: string | null = null;
  private readonly events: Events;
  private readonly api: HostBridge;
  private readonly favoriteImporter: FavoriteLinkImporter;
  constructor(private readonly plugin: BijiSyncPlugin) {
    this.events = plugin.app.workspace;
    const saved: unknown = plugin.app.loadLocalStorage(CONTEXT_KEY);
    this.contexts = Array.isArray(saved) ? saved.filter(isTaskContext) : [];
    this.favoriteImporter = new FavoriteLinkImporter({
      credential: () => plugin.settings.apiKey,
      scope: () => this.scope(),
      available: () => this.alive && !plugin.isUpdatePaused() && this.enabled(),
      localTasks: () => this.favoriteTasks(),
      sync: async ids => {
        for (const id of ids) plugin.syncService.markPending(id);
        await plugin.persistSyncState();
        await plugin.syncNow('manual');
      },
    });
    this.api = {
      enableSourceProperties: () => plugin.enableSourcePropertiesTemplate(),
      version: BRIDGE_VERSION,
      integratedDesktop: BUILD_CHANNEL === 'website',
      renderCloudAccount: container => plugin.renderCloudAccount?.(container) ?? (()=>undefined),
      bindingScope: () => this.scope(),
      setDesktopEnabled: enabled => plugin.setDesktopEnabled(enabled),
      capabilities: ['feedback-v1', 'update-pause-v1', 'desktop-control-v1', 'local-retry-v1', 'local-template-v1', 'desktop-local-ai-v1', 'favorite-import-v1'],
      openFeedback: () => plugin.diagnostics?.open(),
      updatePaused: () => plugin.isUpdatePaused(),
      listTasks: () => this.listTasks(),
      resolveTask: (id) => this.resolveTask(id),
      applyMetadata: (request) => this.applyMetadata(request),
      submitFavoriteLinks: (request) => this.favoriteImporter.run(request),
    };
  }
  snapshot(): CompanionState | null { return this.companion; }
  bindingScope(): Promise<string> { return this.scope(); }
  diagnosticTools(): Record<string, string> { return this.companion?.tools ?? {}; }
  enabled(): boolean { return this.companion?.enabled ?? this.companion?.available ?? false; }
  connected(): boolean { return this.companion?.available === true; }
  async prepareUpdate(): Promise<void> {
    if (this.companion?.available && !this.companion.prepareUpdate) throw new Error('请先停止桌面扩展后更新');
    await this.companion?.prepareUpdate?.();
  }
  resumeAfterUpdate(): void { this.companion?.resumeAfterUpdate?.(); }
  async start(): Promise<void> {
    const p = this.plugin;
    p.logger?.log("bridge.started");
    const scope = await this.scope();
    const saved: unknown = p.app.loadLocalStorage(OWNERS_KEY);
    if (
      saved &&
      typeof saved === "object" &&
      !Array.isArray(saved) &&
      Object.values(saved).every(
        (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v),
      )
    )
      this.owners = saved as Record<number, string>;
    else if (saved == null && scope) {
      this.owners = Object.fromEntries(
        Object.keys(p.syncService.getTaskFileMap()).map((id) => [
          Number(id),
          scope,
        ]),
      );
      p.app.saveLocalStorage(OWNERS_KEY, this.owners);
    }
    this.lastScope = scope;
    p.registerEvent(
      this.events.on(BRIDGE_EVENTS.hello, (version) => {
        if (typeof version === "number")
          this.emit(BRIDGE_EVENTS.ready, this.api);
      }),
    );
    p.registerEvent(
      this.events.on(BRIDGE_EVENTS.state, (state) => {
        if (BUILD_CHANNEL === "website" && (!state || typeof state !== "object" || (state as CompanionState).deployment !== "integrated")) return;
        if (state && typeof state === "object" && "version" in state)
          this.companion = (state as CompanionState).version === BRIDGE_VERSION ? state as CompanionState : {version:BRIDGE_VERSION,available:false,enabled:false,message:"桌面协议不兼容，请更新插件"};
        if(this.companion?.enabled&&!p.settings.sourcePropertiesTemplateInitialized)
          void p.enableSourcePropertiesTemplate?.().catch(()=>p.logger?.log('source_properties.template_failed',{},'warn'));
        p.notifyDesktopVariableAvailability?.();
      }),
    );
    p.addCommand({
      id: "desktop-tools",
      name: "桌面扩展与本地素材",
      callback: () => this.showStatus(),
    });
    p.registerInterval(
      window.setInterval(() => {
        void this.checkBinding();
      }, 1000),
    );
    p.app.workspace.onLayoutReady(() => {
      if (!this.alive) return;
      this.emit(BRIDGE_EVENTS.ready, this.api);
      if (
        Platform.isDesktopApp &&
        !p.app.loadLocalStorage(DISMISSED_KEY) &&
        !this.companion?.enabled && BUILD_CHANNEL !== "website"
      )
        this.showStatus();
    });
  }
  private async checkBinding(): Promise<void> {
    const scope = await this.scope();
    if (!this.alive) return;
    if (this.lastScope !== null && scope !== this.lastScope) {
      this.emit(BRIDGE_EVENTS.offline);
      this.emit(BRIDGE_EVENTS.ready, this.api);
    }
    this.lastScope = scope;
  }
  stop(): void {
    this.alive = false;
    this.emit(BRIDGE_EVENTS.offline);
  }
  private emit(event: string, ...args: unknown[]): void {
    try {
      this.events.trigger(event, ...args);
    } catch {
      console.warn("Clip2MD: 桌面扩展事件处理失败，云端同步继续");
    }
  }
  private async scope(): Promise<string> {
    return this.plugin.settings.apiKey
      ? sha256(
          `${this.plugin.settings.installationId}\n${this.plugin.settings.apiKey}`,
        )
      : "";
  }
  async taskSaved(task: SyncTask, notePath: string): Promise<void> {
    if (!this.alive || !task.url || task.status !== "SUCCESS") return;
    const file = this.plugin.app.vault.getFileByPath(notePath);
    if (!(file instanceof TFile)) return;
    const context: TaskContext = {
      noteTitle: task.title || task.source_title || file.basename,
      bindingScope: await this.scope(),
      taskId: task.id,
      sourceUrl: task.url,
      contentVersion: `${task.note_content_version}:${task.source_content_version}`,
      notePath,
      daily: (await this.plugin.app.vault.read(file)).includes(
        `<!-- clip2md-task-start:${task.id} -->`,
      ),
      cloudStatus: task.status === 'SUCCESS' ? 'success' : task.status === 'FAILED' || task.status === 'ERROR' ? 'failed' : 'pending',
      ...(typeof task.source_title === "string" && task.source_title.length > 0
        ? { sourceTitle: task.source_title }
        : {}),
      ...(typeof task.created_at === "string" && task.created_at.length > 0
        ? { createdAt: task.created_at }
        : {}),
      ...(typeof task.source_date === "string" && task.source_date.length > 0
        ? { sourceDate: task.source_date }
        : {}),
      ...(typeof task.content_source === "string" && task.content_source.length > 0
        ? { contentSource: task.content_source }
        : {}),
    };
    if (!isTaskContext(context)) return;
    this.owners[task.id] = context.bindingScope;
    this.plugin.app.saveLocalStorage(OWNERS_KEY, this.owners);
    this.contexts = [
      ...this.contexts.filter(
        (c) =>
          !(
            c.bindingScope === context.bindingScope &&
            c.taskId === context.taskId
          ),
      ),
      context,
    ];
    this.plugin.app.saveLocalStorage(CONTEXT_KEY, this.contexts);
    this.emit(BRIDGE_EVENTS.saved, context);
  }
  private matches(content: string, context: TaskContext): boolean {
    return context.daily
      ? content.includes(`<!-- clip2md-task-start:${context.taskId} -->`)
      : hasTaskId(content, context.taskId) && !content.includes('<!-- clip2md-task-start:');
  }
  async resolveTask(taskId: number): Promise<TaskContext | null> {
    if (!this.alive) return null;
    const scope = await this.scope();
    let context = this.contexts.find(
      (c) => c.bindingScope === scope && c.taskId === taskId,
    );
    if (!context && scope && this.owners[taskId] === scope) {
      const mapped = this.plugin.syncService.getTaskFileMap()[taskId];
      const file = mapped ? this.plugin.app.vault.getFileByPath(mapped) : null;
      if (!file) return null;
      const content = await this.plugin.app.vault.read(file);
      const daily = content.includes(`<!-- clip2md-task-start:${taskId} -->`);
      let sourceUrl: unknown;
      if (daily) {
        const meta = content.match(
          new RegExp(`<!-- clip2md-task-meta:${taskId}:([^>]+) -->`),
        );
        try {
          const value: unknown = meta
            ? JSON.parse(decodeURIComponent(meta[1]))
            : null;
          sourceUrl =
            value && typeof value === "object" && "url" in value
              ? value.url
              : null;
        } catch {
          return null;
        }
      } else {
        const header = content.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/);
        try {
          sourceUrl = header ? parseDocument(header[1]).get("url") : null;
        } catch {
          return null;
        }
      }
      if (typeof sourceUrl !== "string" || !/^https?:\/\//.test(sourceUrl))
        return null;
      context = {
        bindingScope: scope,
        taskId,
        sourceUrl,
        contentVersion:
          "saved-note:" +
          (await sha256(
            projectProofContent(savedTaskContent(content, taskId),sourcePropertyKeys(this.plugin.settings.frontmatterTemplate||'')),
          )),
        notePath: mapped,
        daily,
        cloudStatus: 'unknown',
      };
      if (!this.matches(content, context)) return null;
      this.contexts.push(context);
      this.plugin.app.saveLocalStorage(CONTEXT_KEY, this.contexts);
    }
    if (!context) return null;
    const vault = this.plugin.app.vault;
    const mapped = this.plugin.syncService.getTaskFileMap()[taskId];
    const path = mapped || context.notePath;
    const file = vault.getFileByPath(path);
    if (file && this.matches(await vault.read(file), context))
      return this.validateResolved(context, path, await vault.read(file));
    const found: TFile[] = [];
    for (const candidate of vault.getMarkdownFiles())
      if (this.matches(await vault.read(candidate), context))
        found.push(candidate);
    return found.length === 1
      ? this.validateResolved(
          context,
          found[0].path,
          await vault.read(found[0]),
        )
      : null;
  }
  private async validateResolved(
    context: TaskContext,
    notePath: string,
    content: string,
  ): Promise<TaskContext | null> {
    const header = content.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/);
    if (!context.daily && header) {
      try {
        const url: unknown = parseDocument(header[1]).get("url");
        if (typeof url === "string" && url && url !== context.sourceUrl)
          return null;
      } catch {
        return null;
      }
    }
    const contentVersion = context.contentVersion.startsWith("saved-note:")
      ? "saved-note:" +
        (await sha256(
          projectProofContent(savedTaskContent(content, context.taskId),sourcePropertyKeys(this.plugin.settings.frontmatterTemplate||'')),
        ))
      : context.contentVersion;
    const yaml=header?parseDocument(header[1]):null;
    const noteTitle=typeof yaml?.get('title')==='string'?String(yaml.get('title')):context.noteTitle||notePath.split('/').pop()!.replace(/\.md$/,'');
    let commentFolder=notePath.split('/').slice(0,-1).join('/');
    if(this.plugin.syncService.folderForLocalComments) {
      const task={...this.plugin.syncService.createPreviewTask(),id:context.taskId,url:context.sourceUrl,title:noteTitle,
        source_title:context.sourceTitle||noteTitle,created_at:context.createdAt||(typeof yaml?.get('created_at')==='string'?String(yaml.get('created_at')):new Date(this.plugin.app.vault.getFileByPath(notePath)?.stat?.ctime||0).toISOString()),
        source_date:context.sourceDate||(typeof yaml?.get('date')==='string'?String(yaml.get('date')):null),content_source:context.contentSource||'web',subscription_context:documentMetadata(content)||undefined};
      commentFolder=this.plugin.syncService.folderForLocalComments(task,notePath);
    }
    return {
      ...context,
      notePath,
      contentVersion,
      noteTitle,
      ...(commentFolder ? { commentFolder } : {}),
    };
  }
  private async favoriteTasks(): Promise<Array<Pick<TaskContext, 'taskId' | 'sourceUrl' | 'cloudStatus'>>> {
    const scope = await this.scope();
    const known = new Map<number, Pick<TaskContext, 'taskId' | 'sourceUrl' | 'cloudStatus'>>();
    const mapping = this.plugin.syncService.getTaskFileMap();
    for (const context of this.contexts) {
      if (context.bindingScope === scope && this.plugin.app.vault.getFileByPath(String(mapping[context.taskId] || context.notePath)))
        known.set(context.taskId, context);
    }
    // Legacy mapped notes can use Obsidian's existing metadata index; no full
    // Markdown reads, hashes or per-note cloud requests are needed for dedup.
    for (const [rawId, path] of Object.entries(mapping) as Array<[string, string]>) {
      const taskId = Number(rawId);
      if (known.has(taskId) || this.owners[taskId] !== scope) continue;
      const file = this.plugin.app.vault.getFileByPath(String(path));
      const sourceUrl: unknown = file instanceof TFile ? this.plugin.app.metadataCache?.getFileCache(file)?.frontmatter?.url : undefined;
      if (typeof sourceUrl === 'string') known.set(taskId, { taskId, sourceUrl });
    }
    return [...known.values()];
  }
  async listTasks(): Promise<TaskContext[]> {
    const scope = await this.scope();
    const result: TaskContext[] = [];
    const ids = new Set([
      ...this.contexts
        .filter((c) => c.bindingScope === scope)
        .map((c) => c.taskId),
      ...Object.keys(this.plugin.syncService.getTaskFileMap()).map(Number),
    ]);
    for (const id of ids) {
      try {
        const resolved = await this.resolveTask(id);
        if (resolved) result.push(resolved);
      } catch {
        /* An invalid note cannot block other tasks. */
      }
    }
    return result;
  }
  private applyMetadata(request: MetadataRequest): Promise<MetadataResult> {
    return this.plugin.syncService.runExclusive(async () => {
      if (
        !request ||
        !isTaskContext(request.context) ||
        !validateProperties(request.properties) ||
        !validateProperties(request.previous)
      )
        throw new Error("本地属性请求无效");
      await this.plugin.enableSourcePropertiesTemplate?.();
      const propertyTemplate=this.plugin.settings.frontmatterTemplate||'';
      const propertyKeys=sourcePropertyKeys(propertyTemplate);
      const bindingKey = this.plugin.settings.apiKey;
      const current = await this.resolveTask(request.context.taskId);
      if (
        !current ||
        current.bindingScope !== request.context.bindingScope ||
        current.sourceUrl !== request.context.sourceUrl ||
        current.contentVersion !== request.context.contentVersion
      )
        return { status: "stale", preserved: [] };
      if (
        this.plugin.syncAckQueue
          .snapshot()
          .some(
            (a) =>
              a.taskId === current.taskId &&
              a.savedProof &&
              (!a.savedProof.projection || propertyKeys.some(key=>!a.savedProof?.localPropertyKeys?.includes(key))),
          )
      )
        return { status: "deferred", preserved: [] };
      const file = this.plugin.app.vault.getFileByPath(current.notePath);
      if (!file) return { status: "stale", preserved: [] };
      let preserved: MetadataResult["preserved"] = [];
      await this.plugin.app.vault.process(file, (content) => {
        if (
          !this.alive ||
          bindingKey !== this.plugin.settings.apiKey ||
          !this.matches(content, current)
        )
          throw new Error("笔记身份变化，已停止补充");
        const existing = this.plugin.settings.sourcePropertiesTemplateInitialized?readSourceProperties(content,propertyTemplate):readLocalProperties(content);
        const incoming = current.daily
          ? {
              assets: existing.assets!==undefined&&!Array.isArray(existing.assets)?existing.assets:[
                ...new Set([
                  ...(Array.isArray(existing.assets) ? existing.assets : []),
                  ...(Array.isArray(request.properties.assets)
                    ? request.properties.assets
                    : []),
                ]),
              ],
            }
          : request.properties;
        if(this.plugin.settings.sourcePropertiesTemplateInitialized) {
          const result=applySourceProperties(content,propertyTemplate,incoming,current.daily?existing:request.previous,request.replaceUserValues===true);
          preserved=result.preserved;return result.content;
        }
        const merged = mergeLocalProperties(
          existing,
          incoming,
          current.daily ? existing : request.previous,
          request.replaceUserValues === true,
        );
        preserved = merged.preserved;
        return withLocalProperties(content, merged.next);
      });
      if (request.localValues)
        await this.plugin.app.vault.process(file, (content) => this.applyLocalTemplateValues(content, current.taskId, request.localValues!));
      return { status: "applied", preserved };
    });
  }
  private applyLocalTemplateValues(content: string, taskId: number, values: Record<string, string | number | string[]>): string {
    const pattern = new RegExp(`(<!-- clip2md-local-variable:v1:${taskId}:([a-z_]+):\\d+ -->)[\\s\\S]*?(<!-- /clip2md-local-variable:${taskId}:\\2:\\d+ -->)`, "g");
    return content.replace(pattern, (whole, start: string, name: string, end: string) => {
      if (!(name in values)) return whole;
      const value = values[name];
      const rendered = ["local_cover", "local_media", "local_gallery"].includes(name)
        ? renderLocalMedia(name, value)
        : name === "local_assets" && Array.isArray(value)
          ? value.map(file => `[本地素材](/${encodeURI(file)})`).join("\n\n")
          : String(value ?? "");
      return `${start}${rendered}${end}`;
    });
  }
  private showStatus(): void {
    if (!Platform.isDesktopApp) {
      new Notice("桌面扩展仅在电脑端可用");
      return;
    }
    const modal = new Modal(this.plugin.app);
    modal.titleEl.setText("桌面扩展");
    modal.contentEl.createEl("p", {
      text:
        this.companion?.message ||
        "可安装独立桌面扩展，为云端笔记补充来源属性、视频、字幕、原图和评论。",
    });
    if (this.companion?.available && this.companion.openSettings)
      new Setting(modal.contentEl).addButton((b) =>
        b.setButtonText("打开扩展设置").onClick(() => {
          this.companion?.openSettings?.();
          modal.close();
        }),
      );
    else {
      if (BUILD_CHANNEL === 'website') modal.contentEl.createEl('a', { text: '下载双插件组合包与安装说明', href: 'https://clip2.md/app/sync' });
      modal.contentEl.createEl("p", {
        text: "扩展尚未上架。取得审核通过的安装包后，将三个程序文件手动放入 Vault 配置目录的 plugins/clipmd-desktop-tools/，然后在社区插件设置中启用。主插件不会下载或安装扩展及其依赖。",
      });
    }
    new Setting(modal.contentEl).addButton((b) =>
      b.setButtonText("知道了，不再提示").onClick(() => {
        this.plugin.app.saveLocalStorage(DISMISSED_KEY, true);
        modal.close();
      }),
    );
    modal.onClose = () => this.plugin.app.saveLocalStorage(DISMISSED_KEY, true);
    modal.open();
  }
}
