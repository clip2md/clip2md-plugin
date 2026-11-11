import { requestUrl } from "obsidian";
import type BijiSyncPlugin from "./main";
import { DEFAULT_DAILY_MERGE_FRONTMATTER_TEMPLATE, NEW_DEFAULT_FILENAME_TEMPLATE, NEW_DEFAULT_FRONTMATTER_TEMPLATE } from "./settings";
import { environment, pluginInstallation, sanitizeToolVersions } from "./local-diagnostics";
import { digest, record } from "./persistent-config";
import { automaticUpdateState } from "./client-update-state";
import { CLIP2MD_API_BASE_URL } from "./config";
import { localTimers } from "./local-timers";
import type { DesktopClientSnapshot } from "./companion-protocol";

export async function collectClientInfo(plugin: BijiSyncPlugin) {
  const settings = plugin.settings;
  const companion = plugin.companion?.snapshot();
  let desktop: DesktopClientSnapshot = { supported: false, enabled: companion?.enabled, runtimeVersion: companion?.runtimeVersion, deployment: companion?.deployment, tools: companion?.tools };
  if (companion?.capabilities?.includes("client-info-v1") && companion.getClientInfo) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { desktop = await Promise.race([companion.getClientInfo().catch(() => ({ supported: false })), new Promise<DesktopClientSnapshot>(resolve => { timer = localTimers.setTimeout(() => resolve({ supported: false }), 2000); })]); }
    finally { if (timer) localTimers.clearTimeout(timer); }
  }
  if (!desktop.runtimeVersion && plugin.app.vault?.adapter) {
    const installation = await pluginInstallation(plugin.app.vault.adapter, plugin.app.vault.configDir, "clipmd-desktop-tools");
    desktop.runtimeVersion = installation.version;
  }
  const host = environment();
  return { installationId: settings.installationId,
    environment: { mainVersion: plugin.manifest.version, channel: host.channel, obsidian: host.obsidian, os: host.os, architecture: host.architecture, language: host.language },
    settings: { syncInterval: settings.syncInterval, syncOnStart: settings.syncOnStart, preventReimportAfterLocalRemoval: settings.preventReimportAfterLocalRemoval,
      syncContentMode: settings.syncContentMode, syncContentOrder: settings.syncContentOrder || "note-first", imageMode: settings.imageMode, mergeMode: settings.mergeMode,
      automaticUpdate: automaticUpdateState(settings), customTemplates: { body: settings.template !== "{{content}}", properties: settings.frontmatterTemplate !== NEW_DEFAULT_FRONTMATTER_TEMPLATE,
        filename: settings.filenameTemplate !== NEW_DEFAULT_FILENAME_TEMPLATE, archive: settings.dailyMergeFrontmatterTemplate !== DEFAULT_DAILY_MERGE_FRONTMATTER_TEMPLATE || Object.keys(settings.subscriptionAccounts || {}).length > 0 } },
    desktop: sanitizeDesktop(desktop) };
}
const PLATFORMS = new Set("bilibili douyin xiaohongshu csdn zhihu douban wechat wechat-channel weibo youtube twitter kuaishou toutiao xiaoyuzhou lizhi applepodcasts zsxq taobao web".split(" "));
const FEATURES = new Set("metadata article video comments subtitles images files".split(" "));
export function sanitizeDesktop(value: DesktopClientSnapshot): DesktopClientSnapshot {
  return { supported: value.supported === true, enabled: typeof value.enabled === "boolean" ? value.enabled : undefined,
    runtimeVersion: typeof value.runtimeVersion === "string" && /^[\d.]{1,32}$/.test(value.runtimeVersion) ? value.runtimeVersion : undefined,
    deployment: value.deployment === "integrated" || value.deployment === "companion" ? value.deployment : "unknown",
    platformEnabled: Object.fromEntries(Object.entries(value.platformEnabled || {}).filter(([key, state]) => PLATFORMS.has(key) && typeof state === "boolean")),
    platforms: Object.fromEntries(Object.entries(value.platforms || {}).filter(([key]) => PLATFORMS.has(key)).map(([key, features]) => [key, Object.fromEntries(Object.entries(features).filter(([feature, state]) => FEATURES.has(feature) && typeof state === "boolean"))])),
    tools: sanitizeToolVersions(value.tools),
    toolStates: Object.fromEntries(Object.entries(value.toolStates || {}).filter(([key, state]) => ["ffmpeg", "ytdlp", "whisper"].includes(key) && typeof state === "boolean")) };
}
export class ClientInfoReporter {
  private timer: number | null = null;
  private running = false;
  private dirty = false;
  private stopped = false;
  private failures = 0;
  private blockedKey = "";
  private pausedKey = "";
  private pausedUntil = 0;
  constructor(private readonly plugin: BijiSyncPlugin) {}
  changed(delay = 5000): void {
    this.dirty = true;
    this.schedule(delay);
  }
  stop(): void { this.stopped = true; this.plugin.timers.clearTimeout(this.timer); this.timer = null; }
  private schedule(delay: number): void {
    this.plugin.timers.clearTimeout(this.timer);
    this.timer = null;
    if (this.stopped || !this.plugin.clientInfoAllowed()) return;
    this.timer = this.plugin.timers.setTimeout(() => { this.timer = null; void this.run(); }, delay, "network");
  }
  private async run(): Promise<void> {
    if (this.stopped || !this.plugin.clientInfoAllowed()) return;
    if (this.running) { this.dirty = true; return; }
    const key = this.plugin.settings.apiKey;
    if (key === this.blockedKey) return;
    if (this.pausedKey === key && this.pausedUntil > Date.now()) { this.schedule(this.pausedUntil - Date.now()); return; }
    this.running = true; this.dirty = false;
    let nextDelay = 24 * 3600000;
    try {
      const snapshot = await collectClientInfo(this.plugin);
      const fingerprint = await digest(JSON.stringify(snapshot));
      const storageKey = `clip2md-client-info-${await digest(key + "\n" + snapshot.installationId)}`;
      const previous: unknown = this.plugin.app.loadLocalStorage(storageKey);
      if (record(previous) && previous.fingerprint === fingerprint && typeof previous.at === "number" && previous.at <= Date.now() && Date.now() - previous.at < 24 * 3600000) {
        nextDelay = 24 * 3600000 - (Date.now() - previous.at); return;
      }
      if (!this.current(key)) return;
      const response = await requestUrl({ url: `${CLIP2MD_API_BASE_URL}/sync/client-info`, method: "POST", headers: { "X-API-Key": key },
        contentType: "application/json", body: JSON.stringify(snapshot), throw: false });
      if (!this.current(key)) return;
      if (response.status === 401) { this.blockedKey = key; return; }
      if (response.status === 404 || response.status === 405) {
        this.pausedKey = key; this.pausedUntil = Date.now() + nextDelay; return;
      }
      if (response.status === 429) {
        const header = Object.entries(response.headers || {}).find(([name]) => name.toLowerCase() === "retry-after")?.[1];
        const seconds = Number(header);
        nextDelay = header && Number.isFinite(seconds) ? Math.max(1000, seconds * 1000) : header && Number.isFinite(Date.parse(header)) ? Math.max(1000, Date.parse(header) - Date.now()) : 60000;
        this.pausedKey = key; this.pausedUntil = Date.now() + nextDelay;
        return;
      }
      if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`);
      this.plugin.app.saveLocalStorage(storageKey, { fingerprint, at: Date.now() });
      this.failures = 0;
    } catch (error) {
      nextDelay = Math.min(30 * 60000, 30000 * 2 ** Math.min(this.failures++, 6));
      this.pausedKey = key; this.pausedUntil = Date.now() + nextDelay;
      this.plugin.logger?.log("client_info.failed", {}, "warn", undefined, error);
    } finally {
      this.running = false;
      if (key !== this.plugin.settings.apiKey) { this.failures = 0; this.schedule(0); }
      else this.schedule(this.dirty ? 5000 : nextDelay);
    }
  }
  private current(key: string): boolean { return !this.stopped && this.plugin.clientInfoAllowed() && this.plugin.settings.apiKey === key; }
}
