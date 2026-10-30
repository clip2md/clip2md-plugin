import { beforeEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import type { App } from "obsidian";
const request = vi.hoisted(() => vi.fn());
vi.mock("obsidian", async (importOriginal) => ({
  ...(await importOriginal<typeof import("obsidian")>()),
  requestUrl: request,
}));
import { DiagnosticsUI } from "./diagnostics-ui";
import type { LocalLogger } from "./local-diagnostics";
beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  request.mockReset();
});
function fixture() {
  const disk = new Map<string, string>();
  const folders = new Set<string>();
  const io = {
    exists: async (p: string) => disk.has(p) || folders.has(p),
    read: async (p: string) => {
      if (!disk.has(p)) throw new Error("missing");
      return disk.get(p)!;
    },
    write: async (p: string, value: string) => {
      disk.set(p, value);
    },
    mkdir: async (p: string) => {
      folders.add(p);
    },
    rename: async (from: string, to: string) => {
      if (disk.has(to)) throw new Error("target exists");
      disk.set(to, disk.get(from)!);
      disk.delete(from);
    },
    remove: async (p: string) => {
      disk.delete(p);
    },
  };
  const state = new Map<string, unknown>();
  let key = "first-key";
  const app = {
    vault: { configDir: ".custom", adapter: io },
    loadLocalStorage: (k: string) => state.get(k),
    saveLocalStorage: (k: string, v: unknown) => state.set(k, v),
  } as unknown as App;
  const options = {
    app,
    logger: { device: "device", log: vi.fn() } as unknown as LocalLogger,
    apiBase: "https://api.example/api",
    website: "https://example",
    key: () => key,
    enabled: () => ({}),
  };
  const ui = new DiagnosticsUI(options);
  vi.spyOn(ui, "report").mockResolvedValue({ schema: 1, logs: [] } as any);
  return {
    ui,
    state,
    disk,
    reboot: () => new DiagnosticsUI(options),
    setKey: (value: string) => {
      key = value;
    },
  };
}
describe("manual feedback diagnostics", () => {
  it("creates one ticket and only retries its failed attachment", async () => {
    const f = fixture();
    request
      .mockResolvedValueOnce({ status: 200, json: { id: 7 } })
      .mockResolvedValueOnce({ status: 500 });
    expect(await f.ui.submit("同步出现了问题", true)).toContain("附件尚未上传");
    expect(JSON.stringify([...f.state])).not.toContain("first-key");
    request.mockResolvedValueOnce({ status: 200 });
    expect(await f.ui.retry()).toBe("附件已补传");
    expect(request.mock.calls.map((c) => c[0].url)).toEqual([
      "https://api.example/api/feedback",
      "https://api.example/api/feedback/7/attachments",
      "https://api.example/api/feedback/7/attachments",
    ]);
  });
  it("never submits an old pending report with a different credential", async () => {
    const f = fixture();
    request
      .mockResolvedValueOnce({ status: 200, json: { id: 7 } })
      .mockResolvedValueOnce({ status: 500 });
    await f.ui.submit("同步出现了问题", true);
    f.setKey("second-key");
    expect(await f.ui.retry()).toContain("没有待补传");
    expect(request).toHaveBeenCalledTimes(2);
    f.setKey("first-key");
    request.mockResolvedValueOnce({ status: 200 });
    expect(await f.ui.retry()).toBe("附件已补传");
  });
  it("stops further network calls if the account changes during ticket creation", async () => {
    const f = fixture();
    request.mockImplementationOnce(async () => {
      f.setKey("other");
      return { status: 200, json: { id: 7 } };
    });
    await expect(f.ui.submit("同步出现了问题", true)).rejects.toThrow(
      "账号已变化",
    );
    expect(request).toHaveBeenCalledOnce();
  });
  it("allows a feedback without logs and does not collect or upload diagnostics", async () => {
    const f = fixture();
    request.mockResolvedValue({ status: 200, json: { id: 8 } });
    expect(await f.ui.submit("希望改进这个功能", false)).toContain("未附日志");
    expect(f.ui.report).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledOnce();
  });
  it("keeps a large attachment outside limited localStorage and resumes after plugin restart", async () => {
    const f = fixture();
    vi.mocked(f.ui.report).mockResolvedValue({
      schema: 1,
      logs: ["x".repeat(6 * 1024 * 1024)],
    } as any);
    request
      .mockResolvedValueOnce({ status: 200, json: { id: 9 } })
      .mockResolvedValueOnce({ status: 500 });
    await f.ui.submit("大日志附件上传失败", true);
    expect(f.state.size).toBe(0);
    expect(
      [...f.disk.values()].some((text) => text.length > 6 * 1024 * 1024),
    ).toBe(true);
    request.mockResolvedValueOnce({ status: 200 });
    expect(await f.reboot().retry()).toBe("附件已补传");
    expect(
      request.mock.calls.filter((c) => c[0].url.endsWith("/feedback")),
    ).toHaveLength(1);
  });
});
