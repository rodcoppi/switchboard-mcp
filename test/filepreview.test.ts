// File preview scope + read. The scope check is a security boundary (a message
// body is untrusted), so it gets real filesystem tests: temp roots, files in
// and out of scope, and the escape tricks (.. and symlinks).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_PREVIEW_BYTES,
  PreviewError,
  kindOfPath,
  readPreview,
  resolveInScope,
} from "../src/server/filepreview.js";

let root: string;
let outside: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sb-preview-scope-"));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "sb-preview-out-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe("kindOfPath", () => {
  it("maps extensions to render kinds, defaulting to text", () => {
    expect(kindOfPath("/a/b.png")).toBe("image");
    expect(kindOfPath("/a/b.PDF")).toBe("pdf");
    expect(kindOfPath("/a/readme.md")).toBe("markdown");
    expect(kindOfPath("/a/x.ts")).toBe("code");
    expect(kindOfPath("/a/notes.log")).toBe("text");
    expect(kindOfPath("/a/noext")).toBe("text");
  });
});

describe("resolveInScope (the security boundary)", () => {
  it("resolves a file inside an allowed root", () => {
    const f = path.join(root, "SKILL.md");
    fs.writeFileSync(f, "# hi");
    expect(resolveInScope(f, [root])).toBe(fs.realpathSync(f));
  });

  it("refuses a file outside every root (403)", () => {
    const f = path.join(outside, "secret.txt");
    fs.writeFileSync(f, "nope");
    expect(() => resolveInScope(f, [root])).toThrow(PreviewError);
    try {
      resolveInScope(f, [root]);
    } catch (e) {
      expect((e as PreviewError).status).toBe(403);
    }
  });

  it("a `..` cannot climb out of scope — realpath is checked, not the raw path", () => {
    const f = path.join(outside, "passwd");
    fs.writeFileSync(f, "x");
    // Raw path dips into `root` then climbs out to `outside`.
    const sneaky = path.join(root, "..", path.basename(outside), "passwd");
    expect(() => resolveInScope(sneaky, [root])).toThrow(/Outside the preview scope/);
  });

  it("a symlink pointing out of scope is refused (realpath follows it)", () => {
    const target = path.join(outside, "target.txt");
    fs.writeFileSync(target, "secret");
    const link = path.join(root, "link.txt");
    try {
      fs.symlinkSync(target, link);
    } catch {
      return; // some environments forbid symlinks; the .. test still covers escape
    }
    // The link SITS in scope but RESOLVES outside — realpath is what we check.
    expect(() => resolveInScope(link, [root])).toThrow(/Outside the preview scope/);
  });

  it("a prefix sibling does not count as inside (foo vs foobar)", () => {
    const sibling = `${root}bar`;
    fs.mkdirSync(sibling, { recursive: true });
    const f = path.join(sibling, "x.txt");
    fs.writeFileSync(f, "x");
    try {
      expect(() => resolveInScope(f, [root])).toThrow(/Outside the preview scope/);
    } finally {
      fs.rmSync(sibling, { recursive: true, force: true });
    }
  });

  it("404 for a path that does not exist, and refuses a directory", () => {
    expect(() => resolveInScope(path.join(root, "ghost"), [root])).toThrow(/not found/i);
    expect(() => resolveInScope(root, [root])).toThrow(/directory/i);
  });

  it("refuses a file above the size cap", () => {
    const big = path.join(root, "big.txt");
    fs.writeFileSync(big, Buffer.alloc(MAX_PREVIEW_BYTES + 1, 0x61));
    expect(() => resolveInScope(big, [root])).toThrow(/large/i);
  });

  it("empty path is rejected", () => {
    expect(() => resolveInScope("", [root])).toThrow(PreviewError);
    expect(() => resolveInScope("   ", [root])).toThrow(PreviewError);
  });
});

describe("readPreview", () => {
  it("reads text/markdown/code as UTF-8, accents intact", () => {
    const f = path.join(root, "a.md");
    fs.writeFileSync(f, "# café código ação");
    const r = readPreview(fs.realpathSync(f));
    expect(r.kind).toBe("markdown");
    expect(r.content).toBe("# café código ação");
  });

  it("returns an image as a data: URL", () => {
    const f = path.join(root, "pixel.png");
    // 1x1 PNG.
    fs.writeFileSync(
      f,
      Buffer.from(
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000154a24f2b0000000049454e44ae426082",
        "hex",
      ),
    );
    const r = readPreview(fs.realpathSync(f));
    expect(r.kind).toBe("image");
    expect(r.content?.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("downgrades a NUL-containing 'text' file to binary", () => {
    const f = path.join(root, "prog.txt");
    fs.writeFileSync(f, Buffer.from([0x61, 0x00, 0x62]));
    const r = readPreview(fs.realpathSync(f));
    expect(r.kind).toBe("binary");
    expect(r.content).toBeNull();
  });
});
