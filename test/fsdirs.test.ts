// GET /api/fs/dirs — the folder-browser endpoint behind the dashboard's
// "Browse…" panel (Launch agent form). A real hub on an ephemeral port with a
// stubbed onMessage (no tmux/dispatcher/launcher — the endpoint is pure
// filesystem) browses a TEMP tree; the "conversation" badge is probed against
// an INJECTED temp claudeProjectsDir so these tests never read the operator's
// real ~/.claude/projects index.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startHub, type Hub } from "../src/server/hub.js";

interface FsDirsBody {
  ok: boolean;
  error?: string;
  path?: string;
  parent?: string | null;
  home?: string;
  dirs?: Array<{ name: string; path: string; hasConversation: boolean }>;
  truncated?: boolean;
}

/** Claude Code's project-dir encoding: `/`, `.` and spaces each become `-`. */
function encodeProjectDir(absPath: string): string {
  return absPath.replace(/[/. ]/g, "-");
}

describe("GET /api/fs/dirs — WSL folder browser", () => {
  let base: string; // temp root holding data dir, browsable tree, projects dir
  let tree: string;
  let projectsDir: string;
  let hub: Hub;

  beforeEach(async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-fsdirs-"));
    tree = path.join(base, "tree");
    projectsDir = path.join(base, "claude-projects");
    fs.mkdirSync(projectsDir, { recursive: true });
    // Browsable tree: visible dirs in mixed case (one with a space), a hidden
    // dotdir and a plain file — ONLY the visible dirs may ever be listed.
    fs.mkdirSync(path.join(tree, "beta"), { recursive: true });
    fs.mkdirSync(path.join(tree, "Alpha"));
    fs.mkdirSync(path.join(tree, "gamma dir"));
    fs.mkdirSync(path.join(tree, ".hidden"));
    fs.writeFileSync(path.join(tree, "notes.txt"), "not a directory\n");

    hub = await startHub({
      baseDir: path.join(base, "data"),
      port: 0,
      quiet: true,
      onMessage: () => "queued_offline", // no tmux anywhere in this suite
      claudeProjectsDir: projectsDir, // NEVER the operator's real index
    });
  });

  afterEach(async () => {
    await hub.close();
    fs.rmSync(base, { recursive: true, force: true });
  });

  async function dirsOf(p?: string): Promise<{ status: number; body: FsDirsBody }> {
    const url =
      p === undefined
        ? `${hub.url}/api/fs/dirs`
        : `${hub.url}/api/fs/dirs?path=${encodeURIComponent(p)}`;
    const res = await fetch(url);
    return { status: res.status, body: (await res.json()) as FsDirsBody };
  }

  it("lists ONLY visible subdirectories, sorted case-insensitively", async () => {
    const { status, body } = await dirsOf(tree);
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.path).toBe(tree);
    expect(body.parent).toBe(base);
    expect(body.home).toBe(os.homedir());
    // The file and the dotdir never appear; ordering ignores case.
    expect(body.dirs!.map((d) => d.name)).toEqual(["Alpha", "beta", "gamma dir"]);
    for (const d of body.dirs!) {
      expect(d.path).toBe(path.join(tree, d.name));
      expect(d.hasConversation).toBe(false); // nothing in the projects dir yet
    }
    expect(body).not.toHaveProperty("truncated"); // only present when capped
  });

  it("flags hasConversation only when the encoded projects entry holds a .jsonl file", async () => {
    // Alpha: a real conversation (one .jsonl file in its encoded dir).
    const alphaDir = path.join(projectsDir, encodeProjectDir(path.join(tree, "Alpha")));
    fs.mkdirSync(alphaDir, { recursive: true });
    fs.writeFileSync(path.join(alphaDir, "01SESSION.jsonl"), "{}\n");
    // "gamma dir": proves the space → "-" encoding really matches.
    const gammaDir = path.join(
      projectsDir,
      encodeProjectDir(path.join(tree, "gamma dir")),
    );
    fs.mkdirSync(gammaDir, { recursive: true });
    fs.writeFileSync(path.join(gammaDir, "01OTHER.jsonl"), "{}\n");
    // beta: its encoded dir exists but holds only a SUBDIR named *.jsonl —
    // the probe wants a real file, so this must NOT count.
    const betaDir = path.join(projectsDir, encodeProjectDir(path.join(tree, "beta")));
    fs.mkdirSync(path.join(betaDir, "fake.jsonl"), { recursive: true });

    const { body } = await dirsOf(tree);
    const byName = new Map(body.dirs!.map((d) => [d.name, d.hasConversation]));
    expect(byName.get("Alpha")).toBe(true);
    expect(byName.get("gamma dir")).toBe(true);
    expect(byName.get("beta")).toBe(false);
  });

  it("defaults to the hub's home directory when path is omitted", async () => {
    const { status, body } = await dirsOf();
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.path).toBe(os.homedir());
    expect(body.home).toBe(os.homedir());
  });

  it("accepts a Windows Explorer \\\\wsl$ path and answers the translated view", async () => {
    const explorerPath = `\\\\wsl$\\Ubuntu${tree.split("/").join("\\")}`;
    const { status, body } = await dirsOf(explorerPath);
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.path).toBe(tree); // translated, not echoed
    expect(body.dirs!.map((d) => d.name)).toEqual(["Alpha", "beta", "gamma dir"]);

    // Trailing slashes are normalized away too.
    const trailing = await dirsOf(`${tree}/`);
    expect(trailing.body.path).toBe(tree);
  });

  it("rejects relative, missing, file and foreign-UNC paths with 400 {ok:false}", async () => {
    // Relative path — the error names the Windows shapes that ARE accepted.
    let r = await dirsOf("relative/x");
    expect(r.status).toBe(400);
    expect(r.body.ok).toBe(false);
    expect(r.body.error).toMatch(/absolute path/);
    expect(r.body.error).toMatch(/wsl\$/);

    // Nonexistent directory.
    r = await dirsOf(path.join(tree, "does-not-exist"));
    expect(r.status).toBe(400);
    expect(r.body.ok).toBe(false);
    expect(r.body.error).toMatch(/Not a browsable directory/);

    // A file is not browsable.
    r = await dirsOf(path.join(tree, "notes.txt"));
    expect(r.status).toBe(400);
    expect(r.body.ok).toBe(false);

    // A non-WSL UNC path stays untranslated and is therefore not absolute.
    r = await dirsOf("\\\\fileserver\\share\\proj");
    expect(r.status).toBe(400);
    expect(r.body.ok).toBe(false);
    expect(r.body.error).toMatch(/absolute path/);
  });

  it("answers parent:null at the filesystem root", async () => {
    const { status, body } = await dirsOf("/");
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.path).toBe("/");
    expect(body.parent).toBeNull();
  });

  it("caps the listing at 500 entries and flags truncated:true", async () => {
    const capDir = path.join(base, "cap");
    fs.mkdirSync(capDir);
    for (let i = 1; i <= 505; i++) {
      fs.mkdirSync(path.join(capDir, `d${String(i).padStart(4, "0")}`));
    }
    const { status, body } = await dirsOf(capDir);
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.truncated).toBe(true);
    expect(body.dirs!).toHaveLength(500);
    // The cap keeps the FIRST 500 in sorted order.
    expect(body.dirs![0].name).toBe("d0001");
    expect(body.dirs![499].name).toBe("d0500");
  });
});
