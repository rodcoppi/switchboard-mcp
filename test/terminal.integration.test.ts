// TerminalBridge against REAL tmux: the bridge exists to prove tmux can be the
// pty, so a mocked tmux would test nothing worth testing here.
// Skipped automatically when tmux is absent (same rule as the other integration
// suites).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createTmux } from "../src/server/tmux.js";
import { TerminalBridge, TerminalError } from "../src/server/terminal.js";

const execFileAsync = promisify(execFile);

let hasTmux = false;
beforeAll(async () => {
  try {
    await execFileAsync("tmux", ["-V"]);
    hasTmux = true;
  } catch {
    hasTmux = false;
  }
});

const silentLog = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as any;

const sessions: string[] = [];
const dirs: string[] = [];

function sessionName(tag: string): string {
  const name = `zz-term-${tag}-${process.pid}-${Date.now()}`;
  sessions.push(name);
  return name;
}

function newDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-term-"));
  dirs.push(dir);
  return dir;
}

function newBridge(dir = newDir()) {
  return new TerminalBridge({ tmux: createTmux(), log: silentLog, dir, pollMs: 20 });
}

async function waitFor(predicate: () => boolean, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

afterEach(async () => {
  for (const s of sessions.splice(0)) {
    await execFileAsync("tmux", ["kill-session", "-t", `=${s}`]).catch(() => {});
  }
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe.runIf(true)("TerminalBridge (real tmux)", () => {
  it("streams what the pane prints, as raw bytes", async () => {
    if (!hasTmux) return;
    const session = sessionName("stream");
    // `cat` echoes its input back: inert (the pane guard allows it) and enough
    // to prove bytes make the round trip.
    await execFileAsync("tmux", ["new-session", "-d", "-s", session, "-x", "80", "-y", "24", "cat"]);
    const bridge = newBridge();

    let seen = Buffer.alloc(0);
    const detach = await bridge.attach(session, (chunk) => {
      seen = Buffer.concat([seen, chunk]);
    });
    try {
      await bridge.input(session, Buffer.from("hello\n"));
      await waitFor(() => seen.toString().includes("hello"));
      expect(seen.toString()).toContain("hello");
    } finally {
      detach();
    }
  }, 20_000);

  it("delivers control bytes as control characters, not as words", async () => {
    if (!hasTmux) return;
    const session = sessionName("ctrl");
    await execFileAsync("tmux", ["new-session", "-d", "-s", session, "-x", "80", "-y", "24", "cat"]);
    const bridge = newBridge();
    const detach = await bridge.attach(session, () => {});
    try {
      // 0x04 = Ctrl-D = EOF. If tmux typed the LETTERS "C-d" instead, `cat`
      // would echo them and live on; the session dying IS the proof the byte
      // arrived as a real control character.
      await bridge.input(session, Buffer.from([0x04]));
      let alive = true;
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline && alive) {
        await new Promise((r) => setTimeout(r, 50));
        alive = await createTmux().hasSession(session);
      }
      expect(alive).toBe(false);
    } finally {
      detach();
    }
  }, 20_000);

  it("the first frame is the screen as it stands, with its colours", async () => {
    if (!hasTmux) return;
    const session = sessionName("frame");
    // printf writes red text, then cat holds the pane open.
    await execFileAsync("tmux", [
      "new-session",
      "-d",
      "-s",
      session,
      "-x",
      "80",
      "-y",
      "24",
      "sh -c 'printf \"\\033[31mREDTEXT\\033[0m\\n\"; cat'",
    ]);
    await new Promise((r) => setTimeout(r, 500));
    const bridge = newBridge();
    const first = await bridge.firstFrame(session);
    expect(first.frame).toContain("REDTEXT");
    // The colour has to survive, or the dashboard paints a grey wall.
    expect(first.frame).toContain("[");
    // The grid ships with the frame because a viewer MIRRORS the pane. It must
    // never size the pane to its own panel: doing that reflowed a real agent's
    // TUI to 316 columns, for the operator's own window too. Asserted against
    // what tmux actually reports rather than the size we asked for at creation:
    // the server has its own say, and the invariant is "the bridge tells the
    // truth about the pane", not a magic number.
    const { stdout: real } = await execFileAsync("tmux", [
      "display-message", "-p", "-t", `=${session}:`, "#{pane_width}x#{pane_height}",
    ]);
    expect(`${first.cols}x${first.rows}`).toBe(real.trim());
  }, 20_000);

  it("stops the tee when the last viewer leaves, and cleans the file up", async () => {
    if (!hasTmux) return;
    const session = sessionName("detach");
    const dir = newDir();
    await execFileAsync("tmux", ["new-session", "-d", "-s", session, "-x", "80", "-y", "24", "cat"]);
    const bridge = newBridge(dir);

    const detachA = await bridge.attach(session, () => {});
    const detachB = await bridge.attach(session, () => {});
    const file = path.join(dir, `${session}.raw`);
    expect(fs.existsSync(file)).toBe(true);

    // One viewer leaving must NOT cut the other one off.
    detachA();
    expect(fs.existsSync(file)).toBe(true);

    detachB();
    await waitFor(() => !fs.existsSync(file));
    // An orphaned pipe-pane would grow this file for the rest of the pane's
    // life with nobody reading it.
    expect(fs.existsSync(file)).toBe(false);
  }, 20_000);

  it("REFUSES to type into a shell pane — the guard rules this path too", async () => {
    if (!hasTmux) return;
    const session = sessionName("guard");
    // A bash pane: exactly what the guard exists for. Typed bytes here would be
    // executed as commands.
    await execFileAsync("tmux", [
      "new-session",
      "-d",
      "-s",
      session,
      "-x",
      "80",
      "-y",
      "24",
      "bash --norc -i",
    ]);
    await new Promise((r) => setTimeout(r, 400));
    const bridge = newBridge();
    await expect(bridge.input(session, Buffer.from("echo pwned\n"))).rejects.toBeInstanceOf(
      TerminalError,
    );
  }, 20_000);

  it("resizes the pane, and refuses a size that is not one", async () => {
    if (!hasTmux) return;
    const session = sessionName("size");
    await execFileAsync("tmux", ["new-session", "-d", "-s", session, "-x", "80", "-y", "24", "cat"]);
    const bridge = newBridge();

    await bridge.resize(session, 120, 30);
    const { stdout } = await execFileAsync("tmux", [
      "display-message",
      "-p",
      "-t",
      `=${session}:`,
      "#{pane_width}x#{pane_height}",
    ]);
    expect(stdout.trim()).toBe("120x30");

    await expect(bridge.resize(session, 0, 30)).rejects.toBeInstanceOf(TerminalError);
    await expect(bridge.resize(session, 99999, 30)).rejects.toBeInstanceOf(TerminalError);
  }, 20_000);
});
