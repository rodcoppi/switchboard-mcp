// The agent's real screen, in the dashboard.
//
// Why this exists: an agent is only visible through a terminal window attached
// to its tmux session, so watching four agents means four Windows windows on
// your taskbar. The owner's words: "eu tenho q ficar com 200 terminal na tela e
// isso é caótico". The dashboard already lists the agents; it should be able to
// show them too, and then the windows can be closed (the session lives in tmux
// and outlives every viewer).
//
// Why there is no node-pty here, unlike the wrapper this was inspired by: tmux
// IS the pty, and it exposes the whole channel already —
//   - output: `pipe-pane` tees the pane's raw bytes, escape sequences included;
//   - input:  `send-keys -H` writes arbitrary bytes, so Escape and Ctrl-C land
//             as real control characters;
//   - size:   `resize-window`.
// A second pty layer would make Switchboard a wrapper: it would own the agent's
// process, and the agent would die with the dashboard instead of outliving it.
// The browser side is xterm.js, the one thing that cannot be sanely hand-rolled.
//
// The pane guard (PRD 10.3) still rules the input path, unchanged: bytes only
// ever reach a pane running an agent, never a shell. A terminal here drives
// agents; it is not a way to get a shell out of the hub.

import fs from "node:fs";
import path from "node:path";
import type { Logger } from "./log.js";
import type { Tmux } from "./tmux.js";

/** How often the tee file is checked for new bytes. */
export const POLL_MS = 40;

/**
 * Refuses absurd sizes before they reach tmux. The upper bound is not a real
 * terminal size, it is a sanity rail on a number that arrives over HTTP.
 */
export const MAX_COLS = 500;
export const MAX_ROWS = 200;

export class TerminalError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "TerminalError";
  }
}

export type TerminalListener = (chunk: Buffer) => void;

interface Live {
  /** Everyone watching this pane. The tee runs while at least one remains. */
  listeners: Set<TerminalListener>;
  file: string;
  fd: number;
  /** Bytes already forwarded — the read cursor into the tee file. */
  offset: number;
  timer: NodeJS.Timeout;
  reading: boolean;
}

export interface TerminalBridgeOptions {
  tmux: Tmux;
  log: Logger;
  /** Where the tee files live (default: <baseDir>/term). */
  dir: string;
  pollMs?: number;
}

/**
 * One bridge per hub, holding one tee per WATCHED pane (not per viewer): tmux
 * pipes a pane to a single command, so a second viewer joins the same stream
 * instead of starting another.
 */
export class TerminalBridge {
  private readonly live = new Map<string, Live>();
  private readonly tmux: Tmux;
  private readonly log: Logger;
  private readonly dir: string;
  private readonly pollMs: number;

  constructor(options: TerminalBridgeOptions) {
    this.tmux = options.tmux;
    this.log = options.log;
    this.dir = options.dir;
    this.pollMs = options.pollMs ?? POLL_MS;
  }

  /**
   * The screen as it stands right now, escape sequences and all, plus the grid
   * it is laid out for. Sent as the viewer's first frame because the tee only
   * carries what the pane does NEXT — without it you would watch a blank
   * rectangle until the agent moved.
   *
   * The size ships with it because a viewer MIRRORS the pane rather than
   * sizing it: see resize() for what imposing a browser panel's size did.
   */
  async firstFrame(session: string): Promise<{ frame: string; cols: number; rows: number }> {
    const [frame, size] = await Promise.all([
      this.tmux.capturePaneAnsi(session),
      this.tmux.paneSize(session),
    ]);
    return { frame, cols: size.cols, rows: size.rows };
  }

  /**
   * Starts (or joins) the tee for `session` and calls `onData` with every byte
   * the pane emits from now on. Returns the detach function; the tee stops when
   * the last viewer detaches.
   */
  async attach(session: string, onData: TerminalListener): Promise<() => void> {
    let entry = this.live.get(session);

    if (!entry) {
      fs.mkdirSync(this.dir, { recursive: true });
      const file = path.join(this.dir, `${session}.raw`);
      // Truncate: a previous viewer's bytes are already on somebody's screen or
      // gone, and replaying them would corrupt this session's paint.
      fs.writeFileSync(file, "");
      await this.tmux.pipePaneToFile(session, file);

      const fd = fs.openSync(file, "r");
      const created: Live = {
        listeners: new Set(),
        file,
        fd,
        offset: 0,
        reading: false,
        timer: setInterval(() => void this.drain(session), this.pollMs),
      };
      // Node keeps the process alive for a pending interval; a hub must be able
      // to exit with a terminal open.
      created.timer.unref?.();
      this.live.set(session, created);
      entry = created;
      this.log.info(`[term] streaming ${session}.`);
    }

    entry.listeners.add(onData);
    return () => this.detach(session, onData);
  }

  private detach(session: string, onData: TerminalListener): void {
    const entry = this.live.get(session);
    if (!entry) return;
    entry.listeners.delete(onData);
    if (entry.listeners.size > 0) return;

    clearInterval(entry.timer);
    try {
      fs.closeSync(entry.fd);
    } catch {
      /* already gone */
    }
    // Stop the tee FIRST: an orphaned pipe-pane would grow this file for the
    // rest of the pane's life with nobody reading it.
    void this.tmux.pipePaneToFile(session, null).catch((err) => {
      this.log.warn(`[term] could not stop the stream of ${session}: ${(err as Error).message}`);
    });
    try {
      fs.rmSync(entry.file, { force: true });
    } catch {
      /* best effort */
    }
    this.live.delete(session);
    this.log.info(`[term] stopped streaming ${session}.`);
  }

  /** Forwards whatever the pane appended since the last pass. */
  private async drain(session: string): Promise<void> {
    const entry = this.live.get(session);
    // reading: a slow read must not overlap the next tick and deliver the same
    // bytes twice.
    if (!entry || entry.reading) return;
    entry.reading = true;
    try {
      const { size } = fs.fstatSync(entry.fd);
      if (size <= entry.offset) return;
      const length = size - entry.offset;
      const buf = Buffer.allocUnsafe(length);
      const read = fs.readSync(entry.fd, buf, 0, length, entry.offset);
      if (read <= 0) return;
      entry.offset += read;
      const chunk = buf.subarray(0, read);
      for (const listener of entry.listeners) listener(chunk);
    } catch (err) {
      this.log.warn(`[term] read failed for ${session}: ${(err as Error).message}`);
    } finally {
      entry.reading = false;
    }
  }

  /**
   * Writes bytes into the pane — THROUGH THE PANE GUARD. The guard is what
   * keeps this from being a shell endpoint: a pane running bash would execute
   * what it is handed, so it is refused, exactly as a nudge would be.
   */
  async input(session: string, bytes: Buffer): Promise<void> {
    if (bytes.length === 0) return;
    if (!(await this.tmux.isPaneSafeToNudge(session))) {
      throw new TerminalError(
        `Refusing to type into "${session}": its pane is not running an agent. ` +
          `Switchboard only ever sends keys to a Claude Code or Codex pane — a shell would ` +
          `execute them as commands.`,
        409,
      );
    }
    await this.tmux.sendKeysHex(session, bytes);
  }

  /**
   * Sizes the pane. Deliberate action only — the dashboard MIRRORS instead.
   *
   * A viewer that fits the grid to its own panel and pushes that size here
   * reflows the agent's TUI for everyone attached to it: a wide browser panel
   * at a small font asked for 316x80 and the agent's terminal became 316
   * columns wide, for the operator's real window too. tmux resize-window is not
   * a per-viewer preference, it is THE window's size.
   */
  async resize(session: string, cols: number, rows: number): Promise<void> {
    if (
      !Number.isInteger(cols) ||
      !Number.isInteger(rows) ||
      cols < 1 ||
      rows < 1 ||
      cols > MAX_COLS ||
      rows > MAX_ROWS
    ) {
      throw new TerminalError(
        `Invalid terminal size ${cols}x${rows} (expected 1..${MAX_COLS} by 1..${MAX_ROWS}).`,
      );
    }
    await this.tmux.resizeWindow(session, cols, rows);
  }

  /** Stops every stream — the hub is going down. */
  closeAll(): void {
    for (const [session, entry] of [...this.live]) {
      for (const listener of [...entry.listeners]) this.detach(session, listener);
    }
  }
}
