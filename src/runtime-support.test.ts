import { beforeEach, describe, expect, it, vi } from "vitest";
import { webcrypto, createHash } from "node:crypto";
import { portableSha256 } from "./sha256-portable";
import { digest } from "./persistent-config";
import type { App } from "obsidian";
import { PersistentConfig, type LocalIO } from "./persistent-config";
import {
  LocalLogger,
  diagnosticReport,
  safeFields,
  readLog,
  LOG_LIMIT,
} from "./local-diagnostics";
class MemoryIO implements LocalIO {
  files = new Map<string, string>();
  folders = new Set<string>();
  fail = false;
  async exists(p: string) {
    return this.files.has(p) || this.folders.has(p);
  }
  async read(p: string) {
    if (!this.files.has(p)) throw new Error("missing");
    return this.files.get(p)!;
  }
  async write(p: string, text: string) {
    this.files.set(p, text);
  }
  async mkdir(p: string) {
    this.folders.add(p);
  }
  async rename(from: string, to: string) {
    if (this.fail) throw new Error("disk error");
    if (this.files.has(to)) throw new Error("target exists");
    this.files.set(to, await this.read(from));
    this.files.delete(from);
  }
  async remove(p: string) {
    this.files.delete(p);
  }
}
const sanitize = (v: unknown) => {
  const data = v as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(data).filter(([k]) =>
      ["targetFolder", "template", "subscriptionAccounts"].includes(k),
    ),
  );
};
const make = (io: MemoryIO) =>
  new PersistentConfig(io, ".custom", "clipmd", sanitize);
beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
});
describe("retained preferences outside removable plugin folders", () => {
  it("restores folders, templates and account maps after deletion and ignores a new login credential", async () => {
    const io = new MemoryIO();
    const first = make(io);
    await first.load(async () => ({
      targetFolder: "我的笔记",
      template: "{{content}}\n自定义",
      apiKey: "secret",
      cursor: "c",
      subscriptionAccounts: { account1: { folder: "one" } },
    }));
    expect(await io.read(first.path)).not.toContain("secret");
    expect(await io.read(first.path)).not.toContain("cursor");
    const reinstalled = await make(io).load(async () => null);
    expect(reinstalled.source).toBe("retained");
    expect(reinstalled.data.targetFolder).toBe("我的笔记");
    expect(reinstalled.data.subscriptionAccounts).toEqual({
      account1: { folder: "one" },
    });
    const login = await make(io).load(async () => ({
      apiKey: "different",
      targetFolder: "wrong",
    }));
    expect(login.data).toEqual(reinstalled.data);
  });
  it("falls back through corruption without overwriting an unreadable sole copy", async () => {
    const io = new MemoryIO();
    const config = make(io);
    await config.load(async () => ({ targetFolder: "old" }));
    await config.save({ targetFolder: "new" });
    io.files.set(config.path, "broken");
    expect((await make(io).load(async () => null)).data.targetFolder).toBe(
      "old",
    );
    io.files.set(config.path + ".bak", "also broken");
    await expect(make(io).load(async () => null)).rejects.toThrow("保留配置");
    expect(await io.read(config.path)).toBe("broken");
  });
  it("keeps a valid recovery point on interrupted replacement and rejects writes before recovery", async () => {
    const io = new MemoryIO();
    const config = make(io);
    await expect(config.save({ targetFolder: "bad" })).rejects.toThrow();
    await config.load(async () => ({ targetFolder: "old" }));
    io.fail = true;
    await expect(config.save({ targetFolder: "new" })).rejects.toThrow(
      "disk error",
    );
    io.fail = false;
    expect((await make(io).load(async () => null)).data.targetFolder).toBe(
      "old",
    );
  });
  it("serializes revisions and only clears explicitly selected plugin preferences", async () => {
    const io = new MemoryIO();
    const config = make(io);
    await config.load(async () => null);
    await Promise.all([
      config.save({ targetFolder: "a" }),
      config.save({ targetFolder: "b" }),
    ]);
    expect(JSON.parse(await io.read(config.path)).revision).toBe(2);
    io.files.set(".custom/clip2md/settings/clipmd-desktop-tools.json", "other");
    await config.clear();
    expect(await io.exists(config.path)).toBe(false);
    expect(
      await io.read(".custom/clip2md/settings/clipmd-desktop-tools.json"),
    ).toBe("other");
  });
});
describe("local diagnostics", () => {
  function app(io: MemoryIO) {
    const local = new Map();
    return {
      vault: { configDir: ".custom", adapter: io },
      loadLocalStorage: (k: string) => local.get(k),
      saveLocalStorage: (k: string, v: unknown) => local.set(k, v),
    } as unknown as App;
  }
  it("rejects secret/path/URL/free-text fields before disk persistence", async () => {
    const io = new MemoryIO(),
      a = app(io),
      logger = new LocalLogger(a, "clipmd", "1.0.22");
    logger.log("sync.failed", {
      taskId: 4,
      httpStatus: 401,
      message: "secret",
      source: "https://x?token=secret",
      code: "clip2md_secret",
      template: "private",
      status: "failed",
    });
    await logger.flush();
    const text = await io.read(logger.path);
    expect(text).not.toMatch(/secret|https|private/);
    expect(safeFields({ source: "/Users/private", taskId: 1 })).toEqual({
      taskId: 1,
    });
  });
  it("collects exactly the 24-hour window from both plugins and declares missing/truncated coverage", async () => {
    const io = new MemoryIO(),
      a = app(io),
      logger = new LocalLogger(a, "clipmd", "1.0.22");
    logger.log("plugin.start");
    await logger.flush();
    const file = readLog(await io.read(logger.path));
    const now = Date.now(),
      start = now - 86400000;
    file.entries = [start - 1, start, now, now + 1].map((t) => ({
      ...file.entries[0],
      time: new Date(t).toISOString(),
    }));
    file.discardedAt = new Date(start).toISOString();
    await io.write(logger.path, JSON.stringify(file));
    const report = await diagnosticReport(a, logger, { clipmd: true }, {}, now);
    expect(report.logs[0].entries).toHaveLength(2);
    expect(report.logs[0].state).toBe("truncated");
    expect(report.logs[1].state).toBe("missing");
    // Export reads allowlisted fields again, even if a local log was externally modified.
    const raw = JSON.parse(await io.read(logger.path));
    raw.entries[0].fields = {
      cookie: "secret",
      source: "https://bad",
      count: 2,
    };
    expect(readLog(JSON.stringify(raw)).entries[0].fields).toEqual({
      count: 2,
    });
  });
  it("keeps logging errors from blocking plugin functionality", async () => {
    const io = new MemoryIO(),
      logger = new LocalLogger(app(io), "clipmd", "1.0.22");
    io.fail = true;
    logger.log("plugin.start");
    await expect(logger.flush()).resolves.toBeUndefined();
    expect(LOG_LIMIT).toBe(10 * 1024 * 1024);
  });
});

describe("portable integrity checks", () => {
  it.each(["", "abc", "中文😀".repeat(100), "x".repeat(1000000)])(
    "matches standard SHA-256 vectors (%#)",
    (text) => {
      expect(portableSha256(new TextEncoder().encode(text))).toBe(
        createHash("sha256").update(text).digest("hex"),
      );
    },
  );
  it("restores retained preferences without requiring a WebCrypto host", async () => {
    vi.stubGlobal("crypto", undefined);
    expect(await digest("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    const io = new MemoryIO(),
      config = make(io);
    await config.load(async () => ({ targetFolder: "kept" }));
    expect((await make(io).load(async () => null)).data.targetFolder).toBe(
      "kept",
    );
  });
});

describe("native adapter recovery points", () => {
  it("restores a configuration interrupted between the two native renames", async () => {
    const io = new MemoryIO(),
      config = make(io);
    await config.load(async () => ({ targetFolder: "recover-me" }));
    await io.rename(config.path, config.path + ".previous");
    const restored = await make(io).load(async () => null);
    expect(restored.source).toBe("backup");
    expect(restored.data.targetFolder).toBe("recover-me");
  });
  it("drops unrecognized top-level log fields during export", () => {
    const entry = {
      time: new Date().toISOString(),
      level: "info",
      plugin: "clipmd",
      version: "1.0.22",
      channel: "market",
      event: "plugin.start",
      operation: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
      fields: {},
      apiKey: "must-not-export",
    };
    const report = readLog(JSON.stringify({ schema: 1, entries: [entry] }));
    expect(report.entries).toHaveLength(1);
    expect(JSON.stringify(report)).not.toContain("must-not-export");
  });
});

describe("retained recovery backup integrity", () => {
  it("keeps a verified backup when only the native previous file was readable", async () => {
    const io = new MemoryIO(),
      config = make(io);
    await config.load(async () => ({ targetFolder: "recover-me" }));
    await io.rename(config.path, config.path + ".previous");
    io.files.set(config.path, "corrupt");
    const recovering = make(io);
    await recovering.load(async () => null);
    io.fail = true;
    await expect(recovering.save({ targetFolder: "next" })).rejects.toThrow();
    io.fail = false;
    expect((await make(io).load(async () => null)).data.targetFolder).toBe(
      "recover-me",
    );
  });
});
