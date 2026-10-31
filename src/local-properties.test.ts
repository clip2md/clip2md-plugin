import { webcrypto } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TFile } from "obsidian";
import {
  mergeLocalProperties,
  preserveLocalProperties,
  projectLocalProperties,
  readLocalProperties,
  withLocalProperties,
} from "./local-properties";
import { sha256, verifySavedSyncProof } from "./saved-sync-proof";
beforeEach(() => vi.stubGlobal("crypto", webcrypto));
describe("local properties are isolated from cloud write proofs", () => {
  const body =
    '---\ntitle: "Cloud"\nurl: https://example.test/post\n---\n\nCloud body\n';
  it("round-trips the exact cloud text, including formatting", () => {
    const next = withLocalProperties(body, {
      author: "原作者",
      likes: 0,
      assets: ["a b/视频.mp4"],
    });
    expect(readLocalProperties(next)).toEqual({
      author: "原作者",
      likes: 0,
      assets: ["a b/视频.mp4"],
    });
    expect(projectLocalProperties(next)).toBe(body);
    expect(
      projectLocalProperties(withLocalProperties("body", { author: "a" })),
    ).toBe("body");
  });
  it("does not exclude body text, similarly named fields or forged markers", () => {
    const text =
      body +
      "\nclip2md_local_author: body text\n<!-- clip2md-local:start -->secret<!-- clip2md-local:end -->";
    expect(projectLocalProperties(text)).toBe(text);
    const unknown = body.replace("title:", "clip2md_local_title:");
    expect(projectLocalProperties(unknown)).toBe(unknown);
  });
  it("rejects duplicate YAML keys, aliases and complex property keys", () => {
    for (const yaml of [
      "title: a\ntitle: b",
      "clip2md_local_author: &a hidden\ntitle: *a",
    ])
      expect(() => projectLocalProperties(`---\n${yaml}\n---\nbody`)).toThrow();
  });
  it("cannot hide a cloud field inside a flow mapping or multiline local value", () => {
    expect(() =>
      projectLocalProperties(
        "---\n{title: Cloud, clip2md_local_author: author}\n---\nbody",
      ),
    ).toThrow();
    const input =
      "---\ntitle: Cloud\nclip2md_local_author: |\n  text\n  more text\nurl: https://example.test/post\n---\nbody";
    expect(projectLocalProperties(input)).toBe(
      "---\ntitle: Cloud\nurl: https://example.test/post\n---\nbody",
    );
  });
  it("preserves local fields over cloud re-render and keeps user edits", () => {
    const next = preserveLocalProperties(
      withLocalProperties(body, { author: "用户修改" }),
      body.replace("Cloud body", "Updated body"),
    );
    expect(readLocalProperties(next).author).toBe("用户修改");
    expect(
      mergeLocalProperties(
        { author: "用户修改", likes: 0 },
        { author: "新值", likes: 4 },
        { author: "旧值", likes: 0 },
      ),
    ).toEqual({
      next: { author: "用户修改", likes: 4 },
      preserved: ["author"],
    });
    expect(() =>
      preserveLocalProperties(
        body,
        withLocalProperties(body, { author: "云端伪造" }),
      ),
    ).toThrow();
  });
  it("allows new proof local edits but refuses missing cloud text and legacy proof edits", async () => {
    let content = body;
    const file = Object.assign(new TFile(), { path: "note.md" });
    const vault = {
      getAbstractFileByPath: () => file,
      read: async () => content,
    };
    const legacy = {
      filepath: "note.md",
      contentHash: await sha256(body),
      images: [],
    };
    const modern = { ...legacy, projection: "local-properties-v1" as const };
    content = withLocalProperties(body, { author: "作者" });
    expect(await verifySavedSyncProof(vault as never, 42, modern)).toBe(true);
    expect(await verifySavedSyncProof(vault as never, 42, legacy)).toBe(false);
    content = content.replace("Cloud body", "");
    expect(await verifySavedSyncProof(vault as never, 42, modern)).toBe(false);
  });
});
