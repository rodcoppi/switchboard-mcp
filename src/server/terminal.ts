// The agent's real screen, in the dashboard — control-mode edition.
//
// Why this exists: an agent is only visible through a terminal window attached
// to its tmux session, so watching four agents means four Windows windows on
// the taskbar. The dashboard lists the agents; it should show them too, and
// then the windows can be closed (the session lives in tmux and outlives every
// viewer).
//
// Why CONTROL MODE and not capture-pane + pipe-pane (the first attempt): those
// are two separate commands with an unclosable gap between snapshot and tee,
// and no cursor or terminal modes in the snapshot. Claude Code's TUI repaints
// relative to the cursor several times a second, so any byte lost or duplicated
// in that gap skewed every following paint — the owner watched new text write
// over old text. A control client (tmux -C) delivers command responses and
// `%output` on ONE ordered stream, so "everything before the capture response
// is in the capture; everything after follows as deltas" holds by construction.
// See the control-mode notes in tmux.ts for the protocol details and the
// sizing-policy spike results.
//
// Sizing: the dashboard DICTATES the window size to fit its panel, exactly as a
// node-pty terminal would — `resize-window` to the panel's grid at the native
// font, so every terminal is crisp and correctly sized. An earlier version
// mirrored the pane and scaled it with CSS when a Windows terminal was attached;
// that made the text big and soft and different from panel to panel, so it was
// scrapped. While the dashboard watches it owns the size (a Windows terminal
// attached alongside reflows to match — one window, one grid), and hands control
// back on the last detach (set-window-option -u window-size). See resize().
//
// The pane guard (PRD 10.3) rules the input path, unchanged: bytes only ever
// reach a pane running an agent, never a shell. A terminal here drives agents;
// it is not a way to get a shell out of the hub.

import type { Logger } from "./log.js";
import type { ControlClient, Tmux } from "./tmux.js";

/**
 * Refuses absurd sizes before they reach tmux. The upper bound is not a real
 * terminal size, it is a sanity rail on a number that arrives over HTTP.
 */
export const MAX_COLS = 500;
export const MAX_ROWS = 200;

export class TerminalError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "TerminalError";
  }
}

/** What a connected dashboard panel receives. */
export interface TerminalViewer {
  /** The pane's grid; the panel sizes its emulator to it. */
  onGrid(grid: { cols: number; rows: number }): void;
  /** Terminal bytes: first a full synthesized frame, then the live deltas. */
  onBytes(bytes: Buffer): void;
  /** The stream is over (session killed, tmux gone). No more calls after this. */
  onEnd(reason: string): void;
}

interface InternalViewer extends TerminalViewer {
  /** %output is forwarded only after this viewer's first frame went out. */
  started: boolean;
}

interface Live {
  cc: ControlClient;
  session: string;
  paneId: string | null;
  viewers: Set<InternalViewer>;
  /** Serializes frames: a layout burst must not interleave two captures. */
  chain: Promise<void>;
  reframeTimer: NodeJS.Timeout | null;
  closed: boolean;
}

export interface TerminalBridgeOptions {
  tmux: Tmux;
  log: Logger;
}

export class TerminalBridge {
  private readonly live = new Map<string, Live>();
  private readonly tmux: Tmux;
  private readonly log: Logger;

  constructor(options: TerminalBridgeOptions) {
    this.tmux = options.tmux;
    this.log = options.log;
  }

  /**
   * Connects a viewer to `session`'s screen: spawns (or joins) the control
   * client, sends this viewer its first frame, then streams. Returns the
   * detach function; the control client dies with its last viewer.
   */
  async attachViewer(session: string, viewer: TerminalViewer): Promise<() => void> {
    const internal = viewer as InternalViewer;
    internal.started = false;

    let entry = this.live.get(session);
    if (!entry) {
      entry = this.spawn(session);
      this.live.set(session, entry);
    }
    entry.viewers.add(internal);

    // Queue this viewer's first frame behind whatever frame work is running —
    // two captures interleaved on one stream would cross their %output cuts.
    const frame = (entry.chain = entry.chain.then(() =>
      this.frame(entry!, [internal]).catch((err) => {
        this.log.warn(`[term] first frame failed for ${session}: ${(err as Error).message}`);
        internal.onEnd((err as Error).message);
        this.detach(session, internal);
      }),
    ));
    await frame;

    return () => this.detach(session, internal);
  }

  private spawn(session: string): Live {
    const entry: Live = {
      session,
      paneId: null,
      viewers: new Set(),
      chain: Promise.resolve(),
      reframeTimer: null,
      closed: false,
      cc: this.tmux.attachControlClient(session, {
        onOutput: (paneId, bytes) => {
          // A session window holds ONE pane in this product; the filter is
          // defense against a user splitting it by hand.
          if (entry.paneId !== null && paneId !== entry.paneId) return;
          for (const v of entry.viewers) if (v.started) v.onBytes(bytes);
        },
        onLayoutChange: () => this.scheduleReframe(entry),
        onExit: (reason) => {
          if (entry.closed) return;
          entry.closed = true;
          if (entry.reframeTimer) clearTimeout(entry.reframeTimer);
          this.live.delete(session);
          this.log.info(`[term] stream of ${session} ended: ${reason}`);
          for (const v of [...entry.viewers]) v.onEnd(reason);
          entry.viewers.clear();
        },
      }),
    };
    this.log.info(`[term] control client attached to ${session}.`);
    return entry;
  }

  /**
   * Window layout changed (Windows terminal resized, our own refresh-client,
   * a manual tmux resize). Debounced re-frame of every viewer: a drag emits a
   * burst of layout events, and each re-frame is a capture round-trip.
   */
  private scheduleReframe(entry: Live): void {
    if (entry.closed) return;
    if (entry.reframeTimer) clearTimeout(entry.reframeTimer);
    entry.reframeTimer = setTimeout(() => {
      entry.reframeTimer = null;
      entry.chain = entry.chain.then(() =>
        this.frame(entry, [...entry.viewers]).catch((err) => {
          this.log.warn(`[term] reframe failed for ${entry.session}: ${(err as Error).message}`);
        }),
      );
    }, 120);
    entry.reframeTimer.unref?.();
  }

  /**
   * Builds and delivers one full frame to `targets`: sizing policy, grid,
   * synthesized screen. The stream-order contract that makes this race-free:
   * a viewer's `started` flips true exactly when its capture block resolves,
   * so every %output before that instant is IN the capture and every one
   * after it reaches the viewer as a delta.
   */
  private async frame(entry: Live, targets: InternalViewer[]): Promise<void> {
    if (entry.closed || targets.length === 0) return;
    const { cc } = entry;
    const t = `=${entry.session}:`;

    // Grid, pane id, cursor. Quoted: '#' starts a comment in a control-mode
    // command line (spike-verified parse error without quotes).
    const info = await cc.command(
      `display-message -p -t '${t}' '#{pane_id} #{pane_width} #{pane_height} #{cursor_x} #{cursor_y} #{cursor_flag}'`,
    );
    const m = /^(%\d+) (\d+) (\d+) (\d+) (\d+) (\d+)$/.exec(info.out[0] ?? "");
    if (!info.ok || !m) {
      throw new Error(`could not read the pane state (${info.out.join(" ") || "no output"})`);
    }
    entry.paneId = m[1];
    const grid = { cols: Number(m[2]), rows: Number(m[3]) };
    const cursor = { x: Number(m[4]), y: Number(m[5]), visible: m[6] === "1" };

    // 3. The screen, colours included. The cursor query above is a hair older
    //    than this capture; both writes land back-to-back on the control
    //    stream, and a mismatch would need pane output in between — microseconds
    //    — and self-heals on the app's next repaint.
    const cap = await cc.command(`capture-pane -p -e -t '${t}'`);
    if (!cap.ok) throw new Error(`capture-pane failed (${cap.out.join(" ")})`);

    // 4. Synthesize. \r\n, not \n: capture prints text LINES, and on a terminal
    //    \n only moves down — \r is what returns to column 0 (a frame without
    //    it painted as a staircase). Cursor hidden while painting, restored per
    //    the pane's own flag, positioned absolutely (ANSI is 1-based).
    const frame = Buffer.from(
      "\x1b[?25l\x1b[0m\x1b[2J\x1b[H" +
        cap.out.join("\r\n") +
        `\x1b[${cursor.y + 1};${cursor.x + 1}H` +
        (cursor.visible ? "\x1b[?25h" : ""),
      "utf8",
    );

    for (const v of targets) {
      if (entry.closed) return;
      v.onGrid(grid);
      v.onBytes(frame);
      v.started = true;
    }
  }

  private detach(session: string, viewer: InternalViewer): void {
    const entry = this.live.get(session);
    if (!entry) return;
    entry.viewers.delete(viewer);
    if (entry.viewers.size > 0 || entry.closed) return;
    entry.closed = true;
    if (entry.reframeTimer) clearTimeout(entry.reframeTimer);
    // Hand size control back before leaving: the dashboard dictated the window
    // size while it was watching (resize()), so unset window-size or a Windows
    // terminal that reattaches later would be stuck at the dashboard's size.
    // Fire-and-forget: the kill right after closes the client regardless.
    entry.cc.command("set-window-option -u window-size").catch(() => {});
    entry.cc.kill();
    this.live.delete(session);
    this.log.info(`[term] stopped streaming ${session} (last viewer left).`);
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
   * The dashboard dictates the window size to fit its panel — exactly what a
   * node-pty terminal does, and the reason the previous "mirror and scale it"
   * approach was scrapped: scaling made the text look big, soft and different
   * from panel to panel. `resize-window` gives the pane the panel's grid at the
   * native font, so every terminal is crisp and correctly sized.
   *
   * While the dashboard watches, it OWNS the size, so a Windows terminal
   * attached alongside reflows to match (one window, one grid — tmux's rule).
   * The old 316-column disaster came from the SCALING path computing an absurd
   * size, not from resize-window; the size here is a sane panel fit. Control is
   * handed back on the last detach (set-window-option -u window-size).
   *
   * The resize triggers %layout-change → reframe, so every viewer repaints at
   * the new grid.
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
    const entry = this.live.get(session);
    if (!entry || entry.closed) return; // no viewer, nothing to size

    entry.chain = entry.chain.then(async () => {
      if (entry.closed) return;
      await entry.cc.command(`resize-window -x ${cols} -y ${rows}`);
    });
    await entry.chain;
  }

  /** Stops every stream — the hub is going down. */
  closeAll(): void {
    for (const [session, entry] of [...this.live]) {
      entry.closed = true;
      if (entry.reframeTimer) clearTimeout(entry.reframeTimer);
      entry.cc.kill();
      this.live.delete(session);
      for (const v of [...entry.viewers]) v.onEnd("the hub is shutting down");
      entry.viewers.clear();
    }
  }
}
