// Unit tests of src/server/launcher.ts's Windows-path acceptance:
// - normalizeIncomingPath (pure): every shape a Windows-side operator
//   realistically pastes into the dashboard's "Launch agent" form — Explorer's
//   \\wsl$\<distro>\... and \\wsl.localhost\<distro>\..., drive paths (C:\...),
//   quoted "Copy as path" output — must come out as the POSIX path the hub can
//   use, and everything else must pass through unchanged;
// - launchAgent over a FAKE in-memory tmux (LauncherTmux is injectable): a
//   \\wsl$ dir really launches into the TRANSLATED directory, and an
//   untranslatable UNC path fails with the improved error message that tells
//   the operator which Windows shapes ARE accepted.
//
// No real tmux and no real claude anywhere in this file; the integration
// counterpart (real tmux + fake claude) lives in launcher.integration.test.ts.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LaunchError,
  createLauncher,
  normalizeIncomingPath,
  type Launcher,
  type LauncherTmux,
} from "../src/server/launcher.js";
import { EventBus } from "../src/server/api.js";
import { DEFAULTS } from "../src/server/config.js";
import { createLogger } from "../src/server/log.js";
import { Store } from "../src/server/store.js";

describe("normalizeIncomingPath", () => {
  it("translates \\\\wsl$\\<distro>\\... to /..., dropping the distro segment", () => {
    // The real user report: the path Windows Explorer gives for a WSL folder.
    expect(
      normalizeIncomingPath("\\\\wsl$\\Ubuntu\\home\\rodcoppi\\projects\\ai panorama"),
    ).toBe("/home/rodcoppi/projects/ai panorama");
  });

  it("translates \\\\wsl.localhost\\<distro>\\... the same way", () => {
    expect(
      normalizeIncomingPath("\\\\wsl.localhost\\Ubuntu\\home\\rodcoppi\\projects\\x"),
    ).toBe("/home/rodcoppi/projects/x");
  });

  it("matches the WSL host case-insensitively", () => {
    expect(normalizeIncomingPath("\\\\WSL$\\Ubuntu\\home\\me")).toBe("/home/me");
    expect(normalizeIncomingPath("\\\\WSL.LocalHost\\Ubuntu\\srv")).toBe("/srv");
  });

  it("accepts any distro name (the segment is dropped either way)", () => {
    expect(normalizeIncomingPath("\\\\wsl$\\Ubuntu-22.04\\opt\\proj")).toBe("/opt/proj");
    expect(normalizeIncomingPath("\\\\wsl$\\Debian\\home\\me")).toBe("/home/me");
  });

  it("maps the distro root to /", () => {
    expect(normalizeIncomingPath("\\\\wsl$\\Ubuntu")).toBe("/");
    expect(normalizeIncomingPath("\\\\wsl$\\Ubuntu\\")).toBe("/");
  });

  it("translates drive paths to the /mnt automount, lowercasing the letter", () => {
    expect(normalizeIncomingPath("C:\\Users\\rod\\my project")).toBe(
      "/mnt/c/Users/rod/my project",
    );
    expect(normalizeIncomingPath("d:\\stuff")).toBe("/mnt/d/stuff"); // lowercase drive
    expect(normalizeIncomingPath("C:\\")).toBe("/mnt/c"); // drive root
    expect(normalizeIncomingPath("C:/Users/rod")).toBe("/mnt/c/Users/rod"); // fwd slashes
  });

  it("strips ONE pair of surrounding quotes (Explorer's \"Copy as path\")", () => {
    expect(
      normalizeIncomingPath('"\\\\wsl$\\Ubuntu\\home\\rodcoppi\\projects\\ai panorama"'),
    ).toBe("/home/rodcoppi/projects/ai panorama");
    expect(normalizeIncomingPath('"C:\\my project"')).toBe("/mnt/c/my project");
    expect(normalizeIncomingPath("'/home/me/proj'")).toBe("/home/me/proj");
    // Only ONE pair: a doubly-quoted path keeps its inner quotes.
    expect(normalizeIncomingPath('""/home/me""')).toBe('"/home/me"');
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeIncomingPath("  /home/me/proj  ")).toBe("/home/me/proj");
    expect(normalizeIncomingPath("  \\\\wsl$\\Ubuntu\\home  ")).toBe("/home");
  });

  it("leaves other \\\\server\\share UNC paths unchanged (rejected downstream)", () => {
    expect(normalizeIncomingPath("\\\\fileserver\\share\\proj")).toBe(
      "\\\\fileserver\\share\\proj",
    );
  });

  it("returns everything else unchanged", () => {
    expect(normalizeIncomingPath("/home/me/proj")).toBe("/home/me/proj");
    expect(normalizeIncomingPath("~/proj")).toBe("~/proj");
    expect(normalizeIncomingPath("relative/path")).toBe("relative/path");
    expect(normalizeIncomingPath("")).toBe("");
    expect(normalizeIncomingPath("C:")).toBe("C:"); // no separator → not a drive path
  });
});

describe("launchAgent (fake tmux) accepts Windows Explorer paths", () => {
  let dir: string;
  let store: Store;
  let bus: EventBus;
  let launcher: Launcher;
  /** Every newSession call the fake tmux received. */
  let created: Array<{ session: string; cwd: string; cmd?: string | string[] }>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-launch-unit-"));
    const log = createLogger({
      level: "error",
      filePath: path.join(dir, "logs", "hub.log"),
      stdout: false,
    });
    store = new Store(dir, log);
    bus = new EventBus();
    created = [];
    const sessions = new Set<string>();
    const tmux: LauncherTmux = {
      hasSession: async (s) => sessions.has(s),
      killSession: async (s) => {
        sessions.delete(s);
      },
      newSession: async (session, cwd, cmd) => {
        sessions.add(session);
        created.push({ session, cwd, cmd });
      },
      capturePane: async () => "? for shortcuts",
      nudgeSession: async () => ({ sent: true }),
    };
    launcher = createLauncher({
      store,
      tmux,
      config: { ...DEFAULTS },
      log,
      bus,
      settleMs: 1,
      sleep: async () => {},
      claudeBin: "/bin/true", // never executed — the fake tmux only records
    });
  });

  afterEach(() => {
    launcher.stop(); // clears the pending kickoff timer
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("launches into the translated POSIX dir when given a \\\\wsl$ path (spaces included)", async () => {
    const project = path.join(dir, "ai panorama");
    fs.mkdirSync(project);
    const explorerPath = `\\\\wsl$\\Ubuntu${project.split("/").join("\\")}`;

    const result = await launcher.launchAgent({ dir: explorerPath, name: "wsl-unit" });

    expect(result.agent.name).toBe("wsl-unit");
    expect(result.agent.cwd).toBe(project); // stored translated, not as pasted
    expect(created).toHaveLength(1);
    expect(created[0].session).toBe("sb-wsl-unit");
    expect(created[0].cwd).toBe(project); // tmux opens the REAL directory
  });

  it("accepts the quoted variant Explorer's \"Copy as path\" produces", async () => {
    const project = path.join(dir, "quoted proj");
    fs.mkdirSync(project);
    const explorerPath = `"\\\\wsl.localhost\\Ubuntu${project.split("/").join("\\")}"`;

    const result = await launcher.launchAgent({ dir: explorerPath, name: "wsl-quoted" });

    expect(result.agent.cwd).toBe(project);
    expect(created[0].cwd).toBe(project);
  });

  it("rejects an untranslatable UNC path with a 400 naming the accepted Windows shapes", async () => {
    const attempt = launcher.launchAgent({ dir: "\\\\fileserver\\share\\proj" });
    await expect(attempt).rejects.toBeInstanceOf(LaunchError);
    await expect(attempt).rejects.toMatchObject({ status: 400 });
    await expect(attempt).rejects.toThrow(/must be an absolute path/);
    // The improved message tells the operator what IS accepted and translated.
    await expect(attempt).rejects.toThrow(/wsl\$/);
    await expect(attempt).rejects.toThrow(/C:\\/);
    await expect(attempt).rejects.toThrow(/accepted and translated/);
    // No side effects: nothing registered, no session created.
    expect(store.listAgents()).toEqual([]);
    expect(created).toEqual([]);
  });
});
