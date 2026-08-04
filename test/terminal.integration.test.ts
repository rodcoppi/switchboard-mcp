// TerminalBridge (control mode) against REAL tmux: the bridge exists to prove
// tmux control mode can be the terminal's backbone, so a mocked tmux would test
// nothing worth testing here. Skipped automatically when tmux is absent (same
// rule as the other integration suites).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createTmux, decodeControlOutput } from "../src/server/tmux.js";
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

function sessionName(tag: string): string {
  const name = `zz-term-${tag}-${process.pid}-${Date.now()}`;
  sessions.push(name);
  return name;
}

async function newCatSession(name: string, cols = 80, rows = 24): Promise<void> {
  // `cat` echoes its input and interprets nothing: inert (the pane guard
  // allows it) and enough to prove bytes make the round trip.
  await execFileAsync("tmux", [
    "new-session",
    "-d",
    "-s",
    name,
    "-x",
    String(cols),
    "-y",
    String(rows),
    "cat",
  ]);
}

function newBridge(): TerminalBridge {
  return new TerminalBridge({ tmux: createTmux(), log: silentLog });
}

interface Collected {
  grids: Array<{ cols: number; rows: number }>;
  chunks: Buffer[];
  ends: string[];
  onGrid(g: { cols: number; rows: number }): void;
  onBytes(b: Buffer): void;
  onEnd(r: string): void;
  text(): string;
}

function makeViewer(): Collected {
  return {
    grids: [],
    chunks: [],
    ends: [],
    onGrid(g) {
      this.grids.push(g);
    },
    onBytes(b) {
      this.chunks.push(b);
    },
    onEnd(r) {
      this.ends.push(r);
    },
    text() {
      return Buffer.concat(this.chunks).toString("utf8");
    },
  };
}

async function waitFor(predicate: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

const countOf = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

afterEach(async () => {
  for (const s of sessions.splice(0)) {
    await execFileAsync("tmux", ["kill-session", "-t", `=${s}`]).catch(() => {});
  }
});

describe("decodeControlOutput (pure)", () => {
  it("passes plain ASCII through and decodes octal escapes to bytes", () => {
    expect(decodeControlOutput("abc").toString()).toBe("abc");
    expect([...decodeControlOutput("a\\015\\012b")]).toEqual([0x61, 0x0d, 0x0a, 0x62]);
    // A backslash escaped as \134 must come back as exactly one byte.
    expect(decodeControlOutput("\\134").toString()).toBe("\\");
  });

  it("re-encodes RAW printable UTF-8 correctly (the accent bug)", () => {
    // tmux sends printable UTF-8 RAW in %output (verified on 3.4): "código"
    // arrives as literal characters. The old charCodeAt & 0xff turned ó
    // (U+00F3) into a lone 0xf3 byte and xterm dropped it. It must round-trip.
    expect(decodeControlOutput("código-café").toString("utf8")).toBe("código-café");
    expect([...decodeControlOutput("ó")]).toEqual([0xc3, 0xb3]);
  });

  it("handles octal escapes and raw UTF-8 mixed in one payload", () => {
    // A real line: ESC sequence (octal) around accented text (raw).
    expect(decodeControlOutput("\\033[1mção\\033[0m").toString("utf8")).toBe("\x1b[1mção\x1b[0m");
  });
});

describe("TerminalBridge (real tmux, control mode)", () => {
  it("streams what the pane prints, as raw bytes, and input reaches it", async () => {
    if (!hasTmux) return;
    const session = sessionName("stream");
    await newCatSession(session);
    const bridge = newBridge();
    const viewer = makeViewer();

    const detach = await bridge.attachViewer(session, viewer);
    try {
      await bridge.input(session, Buffer.from("hello-bridge\n"));
      await waitFor(() => viewer.text().includes("hello-bridge"));
      expect(viewer.text()).toContain("hello-bridge");
      expect(viewer.ends).toEqual([]);
    } finally {
      detach();
    }
  }, 20_000);

  it("first frame: grid, screen content, CRLF, absolute cursor", async () => {
    if (!hasTmux) return;
    const session = sessionName("frame");
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
    const viewer = makeViewer();
    const detach = await bridge.attachViewer(session, viewer);
    try {
      // Grid precedes bytes: the panel must size its emulator before painting.
      // The exact size is the tmux server's own default (80x24 asked for is not
      // guaranteed), so assert the SHAPE, not magic numbers.
      expect(viewer.grids[0].cols).toBeGreaterThan(0);
      expect(viewer.grids[0].rows).toBeGreaterThan(0);
      const frame = viewer.chunks[0].toString("utf8");
      expect(frame).toContain("REDTEXT");
      expect(frame).toContain("\x1b[2J"); // full screen, not a diff
      // The whole reason for the rebuild: the frame must END with an absolute
      // cursor position — relative repaints (Claude Code repaints constantly)
      // land wherever the cursor is, and without this they wrote text over
      // other text.
      expect(frame).toMatch(/\x1b\[\d+;\d+H/);
      // \r\n, never bare \n: capture yields text LINES, and \n alone only
      // moves down — the first attempt painted a staircase.
      expect(frame).not.toMatch(/[^\r]\n/);
    } finally {
      detach();
    }
  }, 20_000);

  it("a byte from before the attach is delivered EXACTLY once (the race)", async () => {
    if (!hasTmux) return;
    const session = sessionName("race");
    await newCatSession(session);
    // The marker lands on the screen before any viewer exists.
    await execFileAsync("tmux", ["send-keys", "-t", `=${session}:`, "-l", "--", "once-marker-77"]);
    await new Promise((r) => setTimeout(r, 400));

    const bridge = newBridge();
    const viewer = makeViewer();
    const detach = await bridge.attachViewer(session, viewer);
    try {
      await new Promise((r) => setTimeout(r, 800));
      // capture-pane + pipe-pane had an unclosable gap here: the marker either
      // vanished (gap) or painted twice (overlap). The control stream's
      // ordering is the entire reason this rebuild exists.
      expect(countOf(viewer.text(), "once-marker-77")).toBe(1);
    } finally {
      detach();
    }
  }, 20_000);

  it("REFUSES to type into a shell pane — the guard rules this path too", async () => {
    if (!hasTmux) return;
    const session = sessionName("guard");
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

  it("dictates the window size to fit the panel", async () => {
    if (!hasTmux) return;
    const session = sessionName("size");
    await newCatSession(session);
    const bridge = newBridge();
    const viewer = makeViewer();
    const detach = await bridge.attachViewer(session, viewer);
    try {
      await bridge.resize(session, 100, 30);
      // The resize lands via tmux and comes back as a layout change → reframe
      // with the new grid.
      await waitFor(() => viewer.grids.some((g) => g.cols === 100 && g.rows === 30));
      expect(viewer.grids.some((g) => g.cols === 100 && g.rows === 30)).toBe(true);
      const { stdout } = await execFileAsync("tmux", [
        "display-message",
        "-p",
        "-t",
        `=${session}:`,
        "#{pane_width}x#{pane_height}",
      ]);
      expect(stdout.trim()).toBe("100x30");

      await expect(bridge.resize(session, 0, 30)).rejects.toBeInstanceOf(TerminalError);
      await expect(bridge.resize(session, 99999, 30)).rejects.toBeInstanceOf(TerminalError);
    } finally {
      detach();
    }
  }, 20_000);

  it("the last viewer's detach kills the control client but NEVER the session", async () => {
    if (!hasTmux) return;
    const session = sessionName("detach");
    await newCatSession(session);
    const bridge = newBridge();
    const a = makeViewer();
    const b = makeViewer();
    const detachA = await bridge.attachViewer(session, a);
    const detachB = await bridge.attachViewer(session, b);

    const clientCount = async (): Promise<number> => {
      const { stdout } = await execFileAsync("tmux", ["list-clients", "-t", `=${session}`]);
      return stdout.split("\n").filter((l) => l.trim() !== "").length;
    };
    expect(await clientCount()).toBe(1); // one control client, shared

    // One viewer leaving must NOT cut the other one off.
    detachA();
    await new Promise((r) => setTimeout(r, 300));
    expect(await clientCount()).toBe(1);

    detachB();
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && (await clientCount()) > 0) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(await clientCount()).toBe(0);
    // The dashboard closing must never take the agent down with it — that is
    // the architectural line between "a terminal" and "a wrapper".
    expect(await createTmux().hasSession(session)).toBe(true);
  }, 20_000);
});

describe("mount race (panel size pushed before the SSE attach)", () => {
  it("a resize BEFORE any viewer is remembered and applied at attach", async () => {
    if (!hasTmux) return;
    const session = sessionName("race");
    await newCatSession(session, 80, 24);
    const bridge = newBridge();

    // The dashboard's mount-time push: no viewer exists yet. The old code
    // dropped this on the floor ("no viewer, nothing to size") and the first
    // frame came at the pane's stale 80x24 — the divergence that scarred the
    // TUI's cursor-relative repaints.
    await bridge.resize(session, 97, 31);

    const viewer = makeViewer();
    const detach = await bridge.attachViewer(session, viewer);
    await waitFor(() => viewer.grids.length > 0);
    expect(viewer.grids[0]).toEqual({ cols: 97, rows: 31 });
    detach();
  }, 20_000);
});

describe("mid-stream frames (the %end/%output chunk race)", () => {
  it("a frame cut while the pane is talking loses not one byte to the race", async () => {
    if (!hasTmux) return;
    // The pane floods numbered tokens "<0><1><2>…" with no pauses, so the
    // chunk that carries a capture's %end almost always carries %output lines
    // right behind it — the exact window where the synchronous dispatch used
    // to hand those bytes to a viewer whose frame did not include them yet
    // (started=false → dropped → the screen stays short a few bytes and the
    // TUI's cursor-relative repaints scar it). Every attach below cuts a
    // FIRST frame mid-stream; consecutiveness across frame+deltas is the
    // no-byte-lost oracle: a drop breaks the token sequence, a chunk split
    // heals in concatenation.
    const session = sessionName("race");
    await execFileAsync("tmux", [
      "new-session", "-d", "-s", session, "-x", "80", "-y", "24",
      "sh", "-c", `awk 'BEGIN{for(i=0;;i++) printf "<%d>", i}'`,
    ]);
    const bridge = newBridge();

    for (let round = 0; round < 12; round++) {
      const viewer = makeViewer();
      const detach = await bridge.attachViewer(session, viewer);
      try {
        // Collect a slice of live deltas behind the frame.
        await waitFor(() => viewer.chunks.length >= 3, 3000);
      } finally {
        detach();
      }
      expect(viewer.chunks.length).toBeGreaterThanOrEqual(2); // frame + deltas: the race window was real
      const text = viewer
        .text()
        .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "") // frame prologue/cursor ANSI
        .replace(/[\r\n]/g, ""); // screen-line joints; tokens reassemble
      const tokens = [...text.matchAll(/<(\d+)>/g)].map((m) => Number(m[1]));
      expect(tokens.length).toBeGreaterThan(20); // sanity: the flood was flowing
      for (let k = 1; k < tokens.length; k++) {
        if (tokens[k] !== tokens[k - 1] + 1) {
          throw new Error(
            `round ${round}: token gap ${tokens[k - 1]} → ${tokens[k]} — bytes were lost at the frame cut`,
          );
        }
      }
    }
  }, 30_000);
});

describe("grid watchdog (the 'torta' screen)", () => {
  it("re-imposes the dashboard's size when something else resizes the pane", async () => {
    if (!hasTmux) return;
    // The scar the owner hit: the pane's grid drifts from what the panel
    // asked for and NOTHING repaints — %layout-change is not guaranteed, so
    // the divergence sat there until he toggled to chat and back (which
    // forces a fresh frame). The watchdog now does that repair on its own.
    const session = sessionName("heal");
    await newCatSession(session, 80, 24);
    const bridge = newBridge();
    const viewer = makeViewer();
    await bridge.resize(session, 100, 30);
    const detach = await bridge.attachViewer(session, viewer);
    try {
      await waitFor(() => viewer.grids.length > 0);
      expect(viewer.grids[0]).toEqual({ cols: 100, rows: 30 });

      // Someone else moves the pane behind the bridge's back (a Windows
      // terminal attaching, a manual tmux resize) — no dashboard involved.
      await execFileAsync("tmux", ["resize-window", "-t", `=${session}:`, "-x", "70", "-y", "20"]);

      // First the layout-change repaint reports the intruder's grid…
      await waitFor(() => viewer.grids.some((g) => g.cols === 70), 8000);
      // …then the watchdog puts the pane back. Poll the PANE (the source of
      // truth): asserting on the viewer's last grid alone would pass on the
      // stale attach frame, before the intruder's repaint even arrived.
      const paneSize = async () =>
        (
          await execFileAsync("tmux", [
            "display-message", "-p", "-t", `=${session}:`, "#{pane_width}x#{pane_height}",
          ])
        ).stdout.trim();
      let restored = "";
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline && restored !== "100x30") {
        restored = await paneSize();
        if (restored !== "100x30") await new Promise((r) => setTimeout(r, 250));
      }
      expect(restored).toBe("100x30"); // the pane itself, healed
      // And the viewers were repainted at the restored grid, not left stale.
      await waitFor(() => {
        const last = viewer.grids[viewer.grids.length - 1];
        return last.cols === 100 && last.rows === 30;
      }, 8000);
      expect(viewer.grids[viewer.grids.length - 1]).toEqual({ cols: 100, rows: 30 });
    } finally {
      detach();
    }
  }, 25_000);
});
