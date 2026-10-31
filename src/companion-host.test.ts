// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { Platform, TFile } from "obsidian";
import { CompanionHost } from "./companion-host";
import {
  BRIDGE_EVENTS,
  type HostBridge,
  type TaskContext,
} from "./companion-protocol";
import { readLocalProperties } from "./local-properties";
import type BijiSyncPlugin from "./main";
const favoriteMocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('obsidian', async original => ({ ...await original<Record<string, unknown>>(), requestUrl: favoriteMocks.request }));
class Bus {
  listeners = new Map<string, Set<(...args: unknown[]) => unknown>>();
  on(name: string, callback: (...args: unknown[]) => unknown) {
    const set = this.listeners.get(name) || new Set();
    set.add(callback);
    this.listeners.set(name, set);
    return { name, callback };
  }
  trigger(name: string, ...args: unknown[]) {
    for (const callback of this.listeners.get(name) || []) callback(...args);
  }
  onLayoutReady(callback: () => void) {
    callback();
  }
}
function fixture(Host = CompanionHost, notePath = "Notes/a.md") {
  Platform.isDesktopApp = true;
  const bus = new Bus();
  const files = new Map([
    [
      notePath,
      "---\ntitle: Original\nurl: https://example.test/post\n---\n<!-- biji-task-id:42 -->\nCloud body",
    ],
  ]);
  const local = new Map<string, unknown>();
  const intervals: number[] = [];
  const file = (path: string) =>
    files.has(path) ? Object.assign(new TFile(), { path }) : null;
  let pending: unknown[] = [];
  let writing = Promise.resolve();
  const plugin = {
    settings: { apiKey: "test-key", installationId: "device-1" },
    app: {
      workspace: bus,
      loadLocalStorage: (key: string) => local.get(key),
      saveLocalStorage: (key: string, value: unknown) =>
        local.set(key, structuredClone(value)),
      vault: {
        getFileByPath: file,
        getMarkdownFiles: () => [...files.keys()].map(file),
        read: async (f: TFile) => files.get(f.path)!,
        process: async (f: TFile, update: (text: string) => string) =>
          files.set(f.path, update(files.get(f.path)!)),
      },
    },
    registerEvent: vi.fn(),
    registerInterval: (id: number) => intervals.push(id),
    addCommand: vi.fn(),
    syncService: {
      getTaskFileMap: () => ({ 42: notePath }),
      runExclusive: <T>(action: () => Promise<T>) => {
        const next = writing.then(action);
        writing = next.then(
          () => undefined,
          () => undefined,
        );
        return next;
      },
    },
    syncAckQueue: { snapshot: () => pending },
  };
  const host = new Host(plugin as unknown as BijiSyncPlugin);
  let bridge!: HostBridge;
  bus.on(BRIDGE_EVENTS.ready, (value) => {
    bridge = value as HostBridge;
  });
  return {
    plugin,
    host,
    bus,
    files,
    local,
    bridge: () => bridge,
    pending: (value: unknown[]) => (pending = value),
    close: () => intervals.forEach(clearInterval),
  };
}
beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});
describe("independent plugin bridge", () => {
  it('updates readable template properties while preserving user edits and deferring incompatible receipts',async()=>{
    const f=fixture();
    Object.assign(f.plugin.settings,{frontmatterTemplate:'---\ntitle: Cloud\n作者: {{local_author}}\n点赞数: {{local_likes}}\n---',sourcePropertiesTemplateInitialized:true});
    f.files.set('Notes/a.md','---\ntitle: Original\nurl: https://example.test/post\n作者: null\n点赞数: null\n---\n<!-- biji-task-id:42 -->\nCloud body');
    await f.host.start();const bridge=f.bridge(),context=(await bridge.listTasks())[0];
    f.pending([{taskId:42,savedProof:{projection:'local-properties-v1'}}]);
    expect((await bridge.applyMetadata({context,properties:{author:'原作者',likes:0},previous:{}})).status).toBe('deferred');
    f.pending([]);await bridge.applyMetadata({context,properties:{author:'原作者',likes:0},previous:{}});
    expect(f.files.get('Notes/a.md')).toContain('作者: 原作者');expect(f.files.get('Notes/a.md')).not.toContain('clip2md_local_');
    f.files.set('Notes/a.md',f.files.get('Notes/a.md')!.replace('作者: 原作者','作者: 我的作者'));
    const result=await bridge.applyMetadata({context:(await bridge.listTasks())[0],properties:{author:'新作者',likes:2},previous:{author:'原作者',likes:0}});
    expect(result.preserved).toContain('author');expect(f.files.get('Notes/a.md')).toContain('作者: 我的作者');expect(f.files.get('Notes/a.md')).toContain('点赞数: 2');
    expect(f.files.get('Notes/a.md')).toContain('Cloud body');f.close();
  });
  it('submits favorites through the credential-owning host and feeds accepted IDs to the existing sync path', async () => {
    const f = fixture();
    const markPending = vi.fn(), persist = vi.fn(async () => {}), syncNow = vi.fn(async () => {});
    Object.assign(f.plugin, { isUpdatePaused: () => false, persistSyncState: persist, syncNow });
    Object.assign(f.plugin.syncService, { markPending });
    await f.host.start();
    f.bus.trigger(BRIDGE_EVENTS.state, { version: 1, available: true, enabled: true, deployment: 'integrated' });
    favoriteMocks.request.mockImplementation(async (args: { url: string; body: string }) => ({ status: 200, headers: {}, json: args.url.endsWith('/auth/me')
      ? { daily_quota: 1, permanent_quota: 0 } : args.url.endsWith('/links/favorites/preflight')
        ? { matches: JSON.parse(args.body).urls.map((url: string) => ({ url, task_id: null })) } : { kind: 'task', task: { id: 99 } } }));
    const bridge = f.bridge(), scope = await bridge.bindingScope!(), saved = vi.fn(async () => {});
    const response = await bridge.submitFavoriteLinks!({ bindingScope: scope, platform: 'douyin', entries: [{ url: 'https://www.douyin.com/video/123', requestKey: 'favorite-request-123' }], shouldContinue: () => true, onResult: saved });
    expect(saved).toHaveBeenCalledWith({ url: 'https://www.douyin.com/video/123', status: 'created', taskId: 99 });
    expect(markPending).toHaveBeenCalledWith(99); expect(persist).toHaveBeenCalled(); expect(syncNow).toHaveBeenCalledWith('manual'); expect(response.syncTriggered).toBe(true);
    expect(favoriteMocks.request.mock.calls.every(([args]) => args.headers['X-API-Key'] === 'test-key')).toBe(true);
    f.close();
  });
  it("supports either load order and never exposes a cloud credential", async () => {
    const f = fixture();
    await f.host.start();
    const bridge = f.bridge();
    expect(bridge.version).toBe(1);
    let ready = 0;
    f.bus.on(BRIDGE_EVENTS.ready, () => ready++);
    f.bus.trigger(BRIDGE_EVENTS.hello, 1);
    expect(ready).toBe(1);
    f.bus.trigger(BRIDGE_EVENTS.hello, 2);
    expect(ready).toBe(2);
    expect(f.bridge().version).toBe(1);
    const tasks = await bridge.listTasks();
    expect(tasks).toHaveLength(1);
    expect(JSON.stringify(tasks)).not.toContain("test-key");
    expect(Object.keys(bridge).sort()).toEqual([
      "applyMetadata",
      "bindingScope",
      "capabilities",
      "enableSourceProperties",
      "integratedDesktop",
      "listTasks",
      "openFeedback",
      "renderCloudAccount",
      "resolveTask",
      "setDesktopEnabled",
      "submitFavoriteLinks",
      "updatePaused",
      "version",
    ]);
    f.close();
  });
  it("keeps saved task context when optional source fields are absent", async () => {
    const f = fixture();
    await f.host.start();
    await f.host.taskSaved(
      {
        id: 42,
        status: "SUCCESS",
        url: "https://example.test/post",
        note_content_version: 1,
        source_content_version: 1,
      } as never,
      "Notes/a.md",
    );
    const context = await f.bridge().resolveTask(42);
    expect(context).toMatchObject({
      taskId: 42,
      sourceUrl: "https://example.test/post",
      notePath: "Notes/a.md",
      cloudStatus: "success",
    });
    expect(context).not.toHaveProperty("sourceTitle");
    expect(context).not.toHaveProperty("createdAt");
    expect(context).not.toHaveProperty("sourceDate");
    expect(context).not.toHaveProperty("contentSource");
    f.close();
  });
  it("accepts root-level notes when applying local metadata", async () => {
    const f = fixture(CompanionHost, "root.md");
    await f.host.start();
    const context = (await f.bridge().listTasks())[0];
    expect(context).not.toHaveProperty("commentFolder");
    expect((await f.bridge().applyMetadata({
      context,
      properties: { author: "根目录作者" },
      previous: {},
    })).status).toBe("applied");
    expect(f.files.get("root.md")).toContain("根目录作者");
    f.close();
  });
  it("defers old receipts and serializes allowed local property changes", async () => {
    const f = fixture();
    await f.host.start();
    const bridge = f.bridge(),
      context = (await bridge.listTasks())[0];
    f.pending([{ taskId: 42, savedProof: { contentHash: "old" } }]);
    expect(
      (
        await bridge.applyMetadata({
          context,
          properties: { author: "作者" },
          previous: {},
        })
      ).status,
    ).toBe("deferred");
    f.pending([]);
    expect(
      (
        await bridge.applyMetadata({
          context,
          properties: { author: "作者", likes: 0 },
          previous: {},
        })
      ).status,
    ).toBe("applied");
    const current = await bridge.resolveTask(42);
    expect(current?.contentVersion).toBe(context.contentVersion);
    expect(readLocalProperties(f.files.get("Notes/a.md")!)).toMatchObject({
      author: "作者",
      likes: 0,
    });
    f.close();
  });
  it("writes native media embeds into the local variable body markers", async () => {
    const f = fixture();
    f.files.set(
      "Notes/a.md",
      "---\ntitle: Original\nurl: https://example.test/post\n---\n<!-- biji-task-id:42 -->\n<!-- clip2md-local-variable:v1:42:local_media:0 --><!-- /clip2md-local-variable:42:local_media:0 -->",
    );
    await f.host.start();
    const context = (await f.bridge().listTasks())[0];
    const result = await f.bridge().applyMetadata({
      context,
      properties: {},
      previous: {},
      localValues: {
        local_media: ["aaa/42/video.mp4", "aaa/42/audio.m4a"],
      },
    });
    expect(result.status).toBe("applied");
    expect(f.files.get("Notes/a.md")).toContain("![[aaa/42/video.mp4]]");
    expect(f.files.get("Notes/a.md")).toContain("![[aaa/42/audio.m4a]]");
    f.close();
  });
  it("rejects stale binding, source and content version, and refuses unknown fields", async () => {
    const f = fixture();
    await f.host.start();
    const bridge = f.bridge(),
      context = (await bridge.listTasks())[0];
    for (const bad of [
      { ...context, sourceUrl: "https://other.test/" },
      { ...context, contentVersion: "changed" },
      { ...context, bindingScope: "a".repeat(64) },
    ])
      expect(
        (
          await bridge.applyMetadata({
            context: bad,
            properties: { author: "x" },
            previous: {},
          })
        ).status,
      ).toBe("stale");
    await expect(
      bridge.applyMetadata({
        context,
        properties: { apiKey: "bad" } as never,
        previous: {},
      }),
    ).rejects.toThrow();
    f.plugin.settings.apiKey = "new-account";
    expect(await bridge.resolveTask(42)).toBeNull();
    f.close();
  });
  it("follows moved notes and stops after unload", async () => {
    const f = fixture();
    await f.host.start();
    await f.bridge().listTasks();
    const body = f.files.get("Notes/a.md")!;
    f.files.delete("Notes/a.md");
    f.files.set("Moved/a.md", body);
    expect((await f.bridge().resolveTask(42))?.notePath).toBe("Moved/a.md");
    f.host.stop();
    expect(await f.bridge().resolveTask(42)).toBeNull();
    f.close();
  });
  it("does not treat an edited source URL as the same work", async () => {
    const f = fixture();
    await f.host.start();
    await f.bridge().listTasks();
    f.files.set(
      "Notes/a.md",
      f.files
        .get("Notes/a.md")!
        .replace("https://example.test/post", "https://example.test/other"),
    );
    expect(await f.bridge().resolveTask(42)).toBeNull();
    f.close();
  });
});

// A suppressed standalone instance must not replace the integrated runtime's API.
it("keeps website runtime state when a standalone plugin reports or unloads", async () => {
  vi.resetModules();
  vi.stubGlobal("CLIP2MD_CHANNEL", "website");
  try {
    const { CompanionHost: WebsiteHost } = await import("./companion-host");
    const f = fixture(WebsiteHost);
    await f.host.start();
    const integrated = { version: 1, deployment: "integrated", available: true, enabled: true, message: "ready" };
    f.bus.trigger(BRIDGE_EVENTS.state, integrated);
    expect(f.host.snapshot()).toBe(integrated);
    for (const state of [
      { version: 1, deployment: "companion", available: false, enabled: false, message: "suppressed" },
      { version: 1, available: false, message: "legacy unload" },
    ]) {
      f.bus.trigger(BRIDGE_EVENTS.state, state);
      expect(f.host.snapshot()).toBe(integrated);
    }
    const stopped = { ...integrated, available: false, enabled: false };
    f.bus.trigger(BRIDGE_EVENTS.state, stopped);
    expect(f.host.snapshot()).toBe(stopped);
    f.close();
  } finally {
    vi.unstubAllGlobals();
    vi.resetModules();
  }
});
