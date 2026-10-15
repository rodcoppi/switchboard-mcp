// Nudge dispatcher (PRD section 10.2 — the pseudocode there IS the spec).
// Responsibility: turn "new message for X" into "X was nudged", respecting
// cooldown and security.
//
// Timing contract (PRD section 4, rule 4 — never block the agent's turn):
// the DECISION in onNewMessage is fully synchronous (pure in-memory state)
// and returns the Delivery immediately so the MCP tool answers < 1s; the
// actual tmux nudge runs asynchronously (fire-and-forget, errors logged).
// Consequence: "tmuxAlive(agent)" from the pseudocode maps to the CACHED
// agent.status maintained by the status polling below (10.4) — freshness is
// enforced on the async path by the pane guard, which fail-closes and marks
// the agent offline when the session died between polls.
//
// Cooldown/coalescing (override rule 3: delivery reliability > realtime):
// lastNudgeAt is stamped SYNCHRONOUSLY when a nudge is decided, so a burst
// of messages in the same tick coalesces into ONE nudge + pending entries;
// check_messages then drains everything at once. A nudge that FAILS (guard
// abort / tmux error — nothing was typed) reverts the stamp, so a real
// message is never held hostage to the cooldown of a nudge that never
// happened; the agent is also quarantined (nudgeBlocked) until its pane
// passes the guard again, which kills the online↔offline polling flap.
//
// The nudge text NEVER contains the message body (PRD 10.2): the fragile
// channel (simulated keyboard) carries one short line; the content always
// travels via MCP.

import { defaultHeadsUpKeys } from "./headsup.js";
import {
  toPublicAgent,
  type Agent,
  type AgentActivity,
  type AgentPermission,
  type AgentPhase,
  type AgentStatus,
  type Config,
  type Delivery,
  type Message,
  type OnMessage,
} from "../shared/types.js";
import type { Logger } from "./log.js";
import type { Store } from "./store.js";
import type { EventBus } from "./api.js";
import type { NudgeResult } from "./tmux.js";

/** Flush cadence for coalesced (pending) nudges — PRD 10.2: "timer a cada 5s". */
export const FLUSH_INTERVAL_MS = 5000;

/**
 * How long a composer may hold messages back before the hub BORROWS the line.
 *
 * A pane whose prompt holds text is never typed into: the nudge would land
 * inside the operator's sentence and the Enter would send the mix. Right — but
 * as a permanent rule it means a line left behind (a nudge whose Enter was
 * refused, an abandoned half-thought) makes the agent deaf forever, and its
 * messages sit in the store while the dashboard shows it idle. That is the
 * limbo the owner refused to live with, and rightly.
 *
 * So the wait has a ceiling. Past it — and only if the SAME text has been
 * sitting there untouched the whole time, so nobody is mid-thought — the hub
 * saves the line, clears it, delivers the nudge, and types the line back
 * exactly as it was. Nothing is ever submitted on the operator's behalf.
 */
export const COMPOSER_HOLD_LIMIT_MS = 90_000;

/**
 * Idle/working sweep cadence. Faster than the 10s status poll because a turn
 * can begin and end within one status interval, and a stale "working" badge is
 * exactly the kind of thing that makes a dashboard feel dead.
 */
export const ACTIVITY_POLL_INTERVAL_MS = 2500;

/** The narrow tmux surface the dispatcher needs (injectable for unit tests). */
export interface DispatcherTmux {
  hasSession(session: string): Promise<boolean>;
  nudgeSession(session: string, text: string, enterDelayMs: number): Promise<NudgeResult>;
  /** Pane guard probe (fail-closed) — used to break the online↔offline flap. */
  isPaneSafeToNudge(session: string): Promise<boolean>;
  /** Reads the pane to tell idle from working. Optional so test mocks may omit it. */
  capturePane?(session: string, lines?: number, escapes?: boolean): Promise<string>;
  /** Literal text into the pane, no Enter — used to put a borrowed line back. */
  sendKeysLiteral?(session: string, text: string): Promise<void>;
  /** Raw bytes — backspaces, to clear a line before borrowing it. */
  sendKeysHex?(session: string, bytes: Buffer): Promise<void>;
}

/** One row of the CLI's background-agents panel. */
export interface SubagentLine {
  /** The agent type it was spawned as ("general-purpose", "Explore"…). */
  type: string;
  /** What it is doing, in the CLI's own words. */
  task: string;
  /** How long it has been at it ("5m 8s"). */
  elapsed: string;
  /** Output tokens so far, verbatim ("244.5k") — null when the row omits it. */
  tokens: string | null;
}

export type HeadsUp = NonNullable<Agent["headsUp"]>;

export interface PaneStatus {
  working: boolean;
  /**
   * A modal question owns the TUI right now ("Do you want to proceed?",
   * trust prompt, development-channel warning). SECURITY-CRITICAL: a nudge
   * types a line and sends Enter ~500ms later, and with one of these open
   * that Enter lands on the HIGHLIGHTED CHOICE — proven on 04/08 with a
   * disposable agent: the nudge accepted a pending Bash permission and the
   * command ran. Never type into a blocked pane.
   */
  blocked: boolean;
  /** Messages are waiting in the CLI's queue ("ctrl+x ctrl+s to send now"). */
  queued: boolean;
  /** The CLI's live line while it works ("Canoodling… (23s · thinking more…)"). */
  spinner: { verb: string; seconds: number; note: string } | null;
  /** A "✦ Heads up" note on screen, with its keyed choices. */
  headsUp: HeadsUp | null;
  /**
   * The operator is MID-SENTENCE in this pane: its prompt line already holds
   * text. A nudge typed now lands inside that half-written prompt and the
   * Enter sends the mix — the owner's words and ours, submitted together.
   * Waiting costs a few seconds; interrupting costs him the message.
   */
  composerBusy: boolean;
  /**
   * WHAT the composer holds, so a rescue can put it back byte for byte after
   * borrowing the line for a nudge. "" when free.
   */
  composerText: string;
  /**
   * The text may continue past the prompt line (it wrapped, or the composer
   * has several lines), so what was read is NOT the whole thing. A rescue
   * would restore a truncated sentence — so it never runs in this case.
   */
  composerWrapped: boolean;
  /**
   * The question a blocked pane is asking and the choices it offers, read
   * off the frame. The dashboard shows them as buttons: with a dialog open
   * the chat's keystrokes never reach the input — worse, its Enter lands on
   * the highlighted choice — so "answer the dialog" has to be its own act,
   * not a message.
   */
  blockedPrompt: string | null;
  blockedOptions: string[];
  /**
   * "Waiting for N background agents to finish", verbatim, when the TUI shows
   * it. This state has NO "esc to interrupt" (the turn's text is done), so
   * without it the poll reads a waiting agent as idle and the chat renders
   * the conversation as finished while work is still pending.
   */
  waitingFor: string | null;
  /**
   * The output-token counter from the spinner line ("↓ 108k tokens"), or null
   * when the frame does not show one. On its own it says little; COMPARED with
   * the previous poll it is the honest way to tell "producing text" from
   * "running a tool / thinking", which no single frame reveals.
   */
  outputTokens: number | null;
  /**
   * The background agents this one has running, read off the CLI's own panel.
   * The transcript says nothing about them until they FINISH, so the pane is
   * the only place a running subagent exists — and "waiting for 2 background
   * agents" without naming them is the frustrating half of that fact.
   */
  subagents: SubagentLine[];
  permission: AgentPermission | null;
  goalActive: boolean;
  goalFor: string | null; // "21m" from "/goal active (21m)", or null
}

/**
 * Keeps only what is LEFT of the TUI's box drawing on one pane line. A dialog
 * that shows previews puts a bordered box beside the choice list, so the line
 * carries two columns; every border glyph lives in U+2500–U+257F, which no
 * option label uses. A line that is only box drawing collapses to "".
 * Exported for direct unit testing.
 */
export function stripSidePanel(line: string): string {
  const cut = line.search(/[\u2500-\u257F]/); // box drawing, the whole block
  return (cut === -1 ? line : line.slice(0, cut)).trimEnd();
}

/** Every SGR/CSI sequence out of a captured line. */
export function stripAnsi(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
}

/**
 * The line's text WITHOUT the runs a TUI drew dim — that is how Claude Code
 * paints the ghost of your last message in an empty composer, and telling it
 * apart from real typing is the whole point of capturing with -e. SGR 2 turns
 * dim on; 22 and 0 turn it off. Exported for direct unit testing.
 */
export function dropDim(line: string): string {
  let out = "";
  let dim = false;
  let i = 0;
  const re = /\u001b\[([0-9;?]*)([A-Za-z])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    if (!dim) out += line.slice(i, m.index);
    i = re.lastIndex;
    if (m[2] !== "m") continue; // not a colour/attribute change
    for (const code of m[1].split(";")) {
      const n = Number(code === "" ? "0" : code);
      if (n === 2) dim = true;
      else if (n === 0 || n === 22) dim = false;
    }
  }
  if (!dim) out += line.slice(i);
  return out;
}

/**
 * The spinner's output-token counter: "↓ 108k tokens" → 108000, "↓ 940 tokens"
 * → 940. Returns null when the line is absent (the CLI only draws it mid-turn).
 * Exported for direct unit testing.
 */
export function parseTokenCount(pane: string): number | null {
  const m = /↓\s*([\d.,]+)\s*(k|m)?\s*tokens/i.exec(stripAnsi(pane));
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] || "").toLowerCase();
  return Math.round(n * (unit === "m" ? 1_000_000 : unit === "k" ? 1_000 : 1));
}

/**
 * The background-agents panel, as the CLI draws it:
 *
 *     ● main
 *   ❯ ◯ general-purpose  Running test-dedup.js with new rule   5m 8s · ↓ 244.5k tokens
 *     ◯ general-purpose  Counting sales per store               5m 3s · ↓ 123.4k tokens
 *
 * Only the ◯ rows are subagents; ● is the main turn. Columns are separated by
 * runs of spaces, which is what lets the task text keep its own single spaces.
 * Exported for direct unit testing.
 */
export function parseSubagents(pane: string): SubagentLine[] {
  const out: SubagentLine[] = [];
  for (const raw of pane.split("\n")) {
    const line = stripAnsi(raw);
    const m = /^\s*[❯>]?\s*[◯○]\s+(\S+)\s{2,}(\S.*?)\s{2,}(\d+(?:m\s*\d+)?s)(?:\s*·\s*↓\s*([\d.]+[km]?)\s*tokens)?\s*$/i.exec(line);
    if (!m) continue;
    out.push({ type: m[1], task: m[2].trim(), elapsed: m[3].replace(/\s+/g, " "), tokens: m[4] ?? null });
    if (out.length >= 8) break; // a panel this long is already unreadable
  }
  return out;
}

/**
 * Reads the live TUI frame for what the operator wants at a glance. Claude Code
 * and Codex run in the alternate screen (no scrollback), so a captured pane is
 * only the CURRENT frame — never stale.
 *   - working: "esc to interrupt" shows only mid-turn.
 *   - permission/plan: the "⏵⏵ <mode> (shift+tab to cycle)" footer line.
 *   - goalActive: the "/goal active" marker Claude Code prints when a goal runs.
 */
export function parsePaneStatus(pane: string): PaneStatus {
  // Phrases are matched on the TEXT, colours off. The pane is captured with
  // -e (the composer needs the dim runs), and Claude Code 2.1.29x colours the
  // footer word by word when bypass is on — "esc⟨SGR⟩ ⟨SGR⟩to⟨SGR⟩ …" — so
  // the raw match never fired and every bypass agent read idle, mid-turn
  // included (found 11/10 with a live pane: all 14 online agents "idle").
  const plain = stripAnsi(pane);
  // …and only where the CLI writes them: the FOOTER under the input box, and
  // the live line just above it. Matching the whole frame read the
  // conversation too — an agent whose last reply QUOTED "esc to interrupt"
  // (this very work, 12/10) showed as working while it sat idle.
  const plainLines = plain.split("\n");
  let promptAt = -1;
  for (let i = plainLines.length - 1; i >= 0; i--) {
    if (/^\s*[❯›>]/.test(plainLines[i])) {
      promptAt = i;
      break;
    }
  }
  const footer = (promptAt >= 0 ? plainLines.slice(promptAt + 1) : plainLines.slice(-4)).join("\n");
  const aboveInput = promptAt >= 0 ? plainLines.slice(Math.max(0, promptAt - 8), promptAt) : [];
  // The live line, the way the CLI draws it ("· Verb… (12s · esc to interrupt)")
  // — at the left edge; the conversation's copies of it are indented.
  const spinnerShaped = (l: string) => /^ ?[·•✢✳✶✻✽*+]\s+\S[^(]*\(\s*\d+[hms]/.test(l);
  const working =
    /esc to interrupt/i.test(footer) || aboveInput.some((l) => spinnerShaped(l) && /esc to interrupt/i.test(l));
  // Modal prompts, by their own wording (each verified in a live pane).
  // WHERE a dialog can be: the conversation is history too, and the
  // operator's own message "1. feito" sits in it as "❯ 1. feito" — read as a
  // choice, it made an agent "ask" with options lifted from its last reply,
  // and a blocked agent is never nudged (12/10). A dialog REPLACES the input
  // box, so its highlighted choice is the LAST caret on screen; when the last
  // caret is the input box, everything above it is conversation. Fail-closed
  // still: the dialog's own wording counts anywhere below that last caret.
  let caretAt = -1;
  for (let i = plainLines.length - 1; i >= 0; i--) {
    if (/^[\s│|]*[❯›]/.test(plainLines[i])) {
      caretAt = i;
      break;
    }
  }
  const choiceAtCaret = caretAt >= 0 && /^[\s│|]*[❯›]\s*\d+\.\s/.test(plainLines[caretAt]);
  const dialogFrom = choiceAtCaret ? Math.max(0, caretAt - 20) : caretAt >= 0 ? caretAt + 1 : Math.max(0, plainLines.length - 15);
  const dialogText = plainLines.slice(dialogFrom).join("\n");
  const blocked =
    choiceAtCaret || // the numbered choice list a modal renders, highlighted
    /Do you want to (?:proceed|create|make|allow)/i.test(dialogText) ||
    /Do you trust the files in this folder\?/i.test(dialogText) ||
    /Loading development channels/i.test(dialogText);
  // Messages typed while it works wait in the CLI's queue, drawn grey above
  // the input with "ctrl+x ctrl+s to send now" (ctrl+enter on terminals that
  // tell it apart) — verified on a live 2.1.296 pane, 11/10.
  // The hint stands on a line of its own, just above the input box.
  const nearInput = promptAt >= 0 ? plainLines.slice(Math.max(0, promptAt - 14), promptAt) : plainLines.slice(-14);
  const queued = nearInput.some((l) => /^\s*(?:ctrl\+x ctrl\+s|ctrl\+enter) to send now\s*$/i.test(l));
  const spinner = working ? parseSpinner(nearInput.join("\n")) : null;
  const headsUp = parseHeadsUp(plain);
  // The LAST prompt line is the live input (the TUI keeps it at the bottom);
  // anything after the caret is text waiting to be sent. NBSP is what the
  // CLIs pad the caret with, and trim() drops it like any other space.
  //
  // …EXCEPT that an empty composer is not blank: Claude Code redraws the last
  // message you sent there as a GHOST, and a ghost reads exactly like a
  // half-written sentence. Every agent that had ever been messaged looked
  // permanently mid-sentence, so it was never nudged again and its messages
  // piled up as "coalesced" — six agents deaf at once, 21/08. The two are
  // distinguishable only in the SGR codes (the ghost is drawn DIM, SGR 2),
  // which is why the pane is captured with -e and the dim runs are dropped
  // here before asking whether anything is left.
  let composerBusy = false;
  let composerText = "";
  let composerWrapped = false;
  const rawLines = pane.split("\n");
  for (let i = rawLines.length - 1; i >= 0; i--) {
    if (!/[❯›>]/.test(stripAnsi(rawLines[i]))) continue;
    const m = /^\s*[❯›>]\s*(.*)$/.exec(dropDim(rawLines[i]));
    if (!m) continue;
    composerText = m[1].trim();
    composerBusy = composerText.length > 0;
    // Does the sentence continue below? The TUI closes its input box with a
    // box-drawing rule, so a line that is neither that rule nor blank is more
    // text — and text we only half-read must never be "restored".
    const below = stripAnsi(rawLines[i + 1] ?? "").trim();
    composerWrapped = below !== "" && !/^[\u2500-\u257F]+$/.test(below);
    break;
  }
  const paneLines = rawLines.map(stripAnsi);
  // The choice list, in order. "❯ 1. Yes" / "  2. No" — the caret marks the
  // highlighted one and is not part of the label.
  const blockedOptions: string[] = [];
  let blockedPrompt: string | null = null;
  if (blocked) {
    // Column-aware: a question with previews draws the choices on the LEFT and
    // a bordered preview box on the RIGHT, both on the same pane line, so the
    // raw line reads "3. É funcionário, não   │ olhar e perguntar que parte…│".
    // Cutting at the box means each option keeps its own words and nothing
    // else (the owner saw the preview text spliced into the buttons, 17/08).
    // Only the dialog's own lines: a numbered list in the conversation above
    // it is not its choices.
    const left = paneLines.slice(dialogFrom).map(stripSidePanel);
    // The choices are the run that ends at the highlighted one: start at the
    // LAST "1." at or above the caret, not the first in sight.
    const caretIn = choiceAtCaret ? caretAt - dialogFrom : left.length - 1;
    let firstChoice = 0;
    for (let k = 0; k <= caretIn && k < left.length; k++) {
      if (/^\s*[❯>]?\s*1\.\s/.test(left[k])) firstChoice = k;
    }
    for (let i = firstChoice; i < left.length; i++) {
      const opt = /^\s*[❯>]?\s*(\d+)\.\s+(\S.*?)\s*$/.exec(left[i]);
      if (!opt) continue;
      const n = Number(opt[1]);
      if (n !== blockedOptions.length + 1) continue; // 1,2,3… only
      if (blockedOptions.length === 0) {
        // The question is the nearest non-empty line above the first choice.
        for (let j = i - 1; j >= 0 && j > i - 6; j--) {
          const t = left[j].trim();
          if (t && !/^[─━-]{3,}$/.test(t)) {
            blockedPrompt = t.slice(0, 200);
            break;
          }
        }
      }
      // A long label WRAPS in the choice column ("3. É funcionário, não" /
      // "   assistente"): the continuation lines are indented, unnumbered and
      // stop at the first blank one. Without them the button loses the half of
      // the sentence that changes its meaning.
      let label = opt[2];
      for (let j = i + 1; j < left.length && j <= i + 3; j++) {
        const cont = left[j];
        if (cont.trim() === "") break;
        if (/^\s*[❯>]?\s*\d+\.\s/.test(cont)) break; // next choice
        if (!/^\s{2,}\S/.test(cont)) break; // not a continuation of this column
        label += ` ${cont.trim()}`;
      }
      blockedOptions.push(label.slice(0, 160));
    }
  }
  const outputTokens = parseTokenCount(pane);
  const subagents = parseSubagents(pane);
  const waitMatch = plain.match(/Waiting for \d+ background (?:agents?|tasks?) to finish/i);
  const waitingFor = waitMatch ? waitMatch[0] : null;
  const goalMatch = plain.match(/\/goal active(?:\s*\(([^)]+)\))?/i);
  const goalActive = goalMatch !== null;
  const goalFor = goalMatch && goalMatch[1] ? goalMatch[1].trim() : null;
  let permission: AgentPermission | null = null;
  // "⏵⏵ bypass permissions on (shift+tab to cycle)" — or, mid-turn, "⏵⏵
  // bypass permissions on · 1 shell · esc to interrupt", with no shift+tab.
  const m = plain.match(/⏵⏵\s*([^·(\n]+?)\s*(?:\(shift\+tab|·|$)/im);
  if (m) {
    const t = m[1].toLowerCase();
    permission = t.includes("bypass")
      ? "bypass"
      : t.includes("accept edits")
        ? "acceptEdits"
        : t.includes("plan")
          ? "plan"
          : "default";
  }
  return { working, blocked, queued, spinner, headsUp, composerBusy, composerText, composerWrapped, outputTokens, subagents, blockedPrompt, blockedOptions, waitingFor, permission, goalActive, goalFor };
}

/**
 * The CLI's own live line, the one with the turning glyph:
 *
 *   · Canoodling… (23s · thinking more with xhigh effort)
 *   * Kneading… (9s · ↓ 113 tokens)
 *   • Working (12s • esc to interrupt)            (codex)
 *   + Topsy-turvying… (19s · still thinking …)   ("+" is one of its frames too)
 *
 * verb = "Canoodling…", seconds = its count of THIS turn (23), note = what is
 * left once the clock, the token count and the key hint are taken out. The
 * LAST such line wins — a finished turn's "✻ Cooked for 3s" above it has no
 * running clock in parentheses and is never mistaken for it. Exported for tests.
 */
export function parseSpinner(plain: string): { verb: string; seconds: number; note: string } | null {
  let found: { verb: string; seconds: number; note: string } | null = null;
  for (const line of plain.split("\n")) {
    // The clock is "23s", "1m 9s", or — on a long turn — just "30m" / "1h 2m".
    // At the left edge (one space at most): the conversation's quotes of a
    // live line are indented, and must not stand in for it.
    const m = /^ ?[·•✢✳✶✻✽*+]\s+(\S[^(\n]*?)\s*\(\s*(?:(\d+)h\s*)?(?:(\d+)m\s*)?(?:(\d+)s)?(?=\s*(?:[·•)]|$))([^)]*)\)/.exec(line);
    if (!m || (m[2] === undefined && m[3] === undefined && m[4] === undefined)) continue;
    const seconds = Number(m[2] || 0) * 3600 + Number(m[3] || 0) * 60 + Number(m[4] || 0);
    const note = m[5]
      .split(/[·•]/)
      .map((p) => p.trim())
      .filter((p) => p && !/tokens?\b/i.test(p) && !/esc to interrupt/i.test(p))
      .join(" · ");
    found = { verb: m[1].trim().slice(0, 40), seconds, note: note.slice(0, 80) };
  }
  return found;
}

/**
 * Claude Code's "Heads up" notes — advice it draws in the pane and never
 * writes to the transcript, so the chat had no way to show them (owner,
 * 11/10: "é bom pra caramba, mas não tem no chat"):
 *
 *   ✦ Heads up · O programa do e-mail não percebe quando alguém marca o
 *     e-mail como spam…
 *     1: Learn more   2: Knew this already   0: Dismiss
 *
 * "Learn more" EXPANDS it in place — a blank line, a detail block (a title
 * and "- " points, wrapped), and new keys at the bottom ("1: Understood
 * 2: Chat in main session 0: Dismiss"); seen live 12/10. Stopping at the
 * first blank line lost those keys and left a card nobody could close. The
 * note runs to its key line, or to the input box's rule / the prompt. The
 * LAST note on screen wins. Exported for tests.
 */
export function parseHeadsUp(plain: string): HeadsUp | null {
  const lines = plain.split("\n");
  let found: HeadsUp | null = null;
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*✦\s*Heads up\s*[·•:-]\s*(.*)$/i.exec(lines[i]);
    if (!m) continue;
    let text = m[1].trim();
    const detail: string[] = [];
    const options: HeadsUp["options"] = [];
    let inDetail = false;
    for (let j = i + 1; j < lines.length && j <= i + 40; j++) {
      const line = lines[j];
      if (/^\s*\d:\s+\S/.test(line)) {
        for (const o of line.matchAll(/(\d):\s+(.+?)(?=\s{2,}\d:|\s*$)/g)) options.push({ key: o[1], label: o[2].trim().slice(0, 40) });
        break;
      }
      // The input box's rule — bare, or carrying the session's name
      // ("──── SWITCHBOARD-PROJECT ─").
      if (/^\s*[\u2500-\u257F]{3,}/.test(line)) break;
      // A long note is cut to a few rows: "↓ 12 more" is the CLI's scroll
      // hint, not part of the note (the full text comes from its store).
      if (/^\s*[↓↑]\s*\d+\s+more\b/i.test(line)) continue;
      if (/^\s*[❯›>]/.test(line)) break;
      if (/^\s*✦\s*Heads up/i.test(line)) break; // the next note
      if (!line.trim()) {
        inDetail = true;
        continue;
      }
      if (!inDetail) {
        text += ` ${line.trim()}`;
        continue;
      }
      // Detail: drop the note's own two-space margin; a deeper indent that is
      // not a new "- " point is the previous line wrapped.
      const body = line.replace(/^ {2}/, "");
      if (/^\s{2,}\S/.test(body) && detail.length && !/^\s*[-•*]\s/.test(body)) detail[detail.length - 1] += ` ${body.trim()}`;
      else detail.push(body.trim());
    }
    text = text.replace(/\s+/g, " ").trim();
    if (text) {
      found = {
        text: text.slice(0, 500),
        detail: detail.slice(0, 12).map((d) => d.slice(0, 400)),
        options: options.slice(0, 4),
      };
    }
  }
  return found;
}

/** Back-compat shim: whether the CLI is mid-turn. */
export function detectWorking(pane: string): boolean {
  return parsePaneStatus(pane).working;
}

export interface DispatcherOptions {
  store: Store;
  config: Config;
  log: Logger;
  bus: EventBus;
  tmux: DispatcherTmux;
  /** Injectable clock (epoch ms) for deterministic tests. Default Date.now. */
  now?: () => number;
  /** Flush cadence override for tests (default FLUSH_INTERVAL_MS = 5s). */
  flushIntervalMs?: number;
  /**
   * Injectable wait, used by the composer rescue to let the TUI repaint before
   * it believes the screen. Tests pass a no-op so nothing sleeps for real.
   */
  sleep?: (ms: number) => Promise<void>;
  /**
   * The full text of a "Heads up" note whose one-liner is on screen, from
   * Claude Code's own store (headsup.ts) — the pane cuts long ones to a few
   * rows and scrolls their keys away. Absent in tests: screen only.
   */
  headsUpLookup?: (text: string) => { detail: string[]; kind: string } | null;
}

/** Outcome of a manual (forced) nudge — consumed by POST /api/agents/:name/nudge. */
export interface ManualNudgeResult {
  sent: boolean;
  reason?: string;
}

export class Dispatcher {
  private readonly store: Store;
  private readonly config: Config;
  private readonly log: Logger;
  private readonly bus: EventBus;
  private readonly tmux: DispatcherTmux;
  private readonly now: () => number;
  /** Injectable wait — the rescue has to let the TUI repaint (tests pass a no-op). */
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly flushIntervalMs: number;
  private readonly headsUpLookup: DispatcherOptions["headsUpLookup"];

  /** Agents waiting for a nudge once their cooldown expires (coalescing). */
  private readonly pendingNudge = new Set<string>();
  /**
   * Agents whose nudges are on hold because their prompt holds unsent text —
   * tracked only so the warning is logged ONCE per stall instead of every
   * five-second flush.
   */
  private readonly heldByComposer = new Set<string>();

  /**
   * Per agent: the composer text that is holding its nudges and the moment it
   * started holding. Reset whenever the text changes — a moving line means the
   * operator IS writing, and the clock starts over.
   */
  private readonly composerHold = new Map<string, { text: string; since: number }>();

  /** Agents whose rescue is already running — never two at once on a pane. */
  private readonly rescuing = new Set<string>();

  /** Output-token counter per agent at the previous sweep — see AgentPhase. */
  private readonly lastOutputTokens = new Map<string, number>();
  /**
   * Agents whose LAST nudge attempt failed (pane guard abort or tmux error).
   * Breaks the perpetual online↔offline flap for "session alive but pane on a
   * shell with unread > 0": pollOnce only promotes a quarantined agent back
   * to online after the pane guard passes again, instead of re-marking it
   * online (and re-attempting a doomed nudge) every poll cycle forever.
   * Cleared on the next SUCCESSFUL nudge or when the pane becomes safe.
   */
  private readonly nudgeBlocked = new Set<string>();
  private flushTimer: NodeJS.Timeout | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private activityTimer: NodeJS.Timeout | undefined;
  private activityInFlight = false;
  /** Guards against overlapping polls when tmux calls outlast the interval. */
  private pollInFlight = false;

  constructor(options: DispatcherOptions) {
    this.store = options.store;
    this.config = options.config;
    this.log = options.log;
    this.bus = options.bus;
    this.tmux = options.tmux;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.flushIntervalMs = options.flushIntervalMs ?? FLUSH_INTERVAL_MS;
    this.headsUpLookup = options.headsUpLookup;
  }

  /**
   * The OnMessage extension point wired into hub.ts (bound so it can be
   * passed around as a plain function). PRD 10.2 pseudocode, faithfully:
   *   muted            → queued_muted
   *   tmux dead        → offline + queued_offline
   *   cooldown active  → pendingNudge.add (coalescing) + coalesced
   *   otherwise        → sendNudge (async) + nudged
   */
  readonly onNewMessage: OnMessage = (message: Message, recipient: Agent): Delivery => {
    // Re-read from the store: `recipient` is a live ref, but going through
    // getAgent keeps this correct even if callers pass a stale copy.
    const agent = this.store.getAgent(recipient.name) ?? recipient;

    if (agent.muted) {
      return "queued_muted";
    }
    // "if !tmuxAlive(agent) → marca offline": status IS the cached tmux
    // liveness (polling owns it), so a non-online agent is already marked —
    // the message queues and the polling online-transition delivers later.
    if (agent.status !== "online") {
      return "queued_offline";
    }
    if (this.inCooldown(agent)) {
      this.pendingNudge.add(agent.name); // coalescing
      return "coalesced";
    }
    // A modal dialog owns the pane: typing now would answer it (proven —
    // see PaneStatus.blocked). Queue instead; the flush delivers once the
    // operator has answered. The cached flag is the fast path; fireNudge
    // re-checks the LIVE pane right before typing (fail-closed).
    if (agent.blocked) {
      this.pendingNudge.add(agent.name);
      return "coalesced";
    }
    if (agent.composerBusy) {
      // Half-written prompt in the pane: queue rather than type into it.
      this.pendingNudge.add(agent.name);
      return "coalesced";
    }
    // The immediate nudge covers ALL unread (count + senders come from the
    // store), so it discharges any coalescing debt — without this delete, a
    // stale pending entry would make the next flush fire a duplicate nudge.
    this.pendingNudge.delete(agent.name);
    this.fireNudge(agent);
    return "nudged";
  };

  /**
   * PRD 10.2 flush timer: for each pending agent whose cooldown expired AND
   * unread > 0 → sendNudge and remove from the set. The decision loop is
   * synchronous; the nudges it fires are async (fire-and-forget).
   * Two additions beyond the pseudocode, both conservative:
   * - muted agents are SKIPPED (kept pending): mute means "nudge suppressed,
   *   message recorded" (PRD 10.1/13) and can be flipped after the message
   *   was coalesced;
   * - non-online agents are SKIPPED (kept pending): the polling
   *   online-transition path is the one that revives them.
   */
  flushPending(): void {
    for (const name of [...this.pendingNudge]) {
      const agent = this.store.getAgent(name);
      if (!agent) {
        this.pendingNudge.delete(name); // unregistered while pending
        continue;
      }
      if (agent.muted) continue;
      if (agent.status !== "online") continue;
      if (this.inCooldown(agent)) continue;
      if (agent.blocked) continue; // a modal still owns the pane — keep waiting
      if (agent.composerBusy) {
        const hold = this.composerHold.get(name);
        const text = agent.composerText ?? "";
        if (!hold || hold.text !== text) {
          // First sighting, or he typed something new: (re)start the clock.
          this.composerHold.set(name, { text, since: this.now() });
        } else if (this.now() - hold.since >= COMPOSER_HOLD_LIMIT_MS) {
          this.borrowComposerAndNudge(agent, text);
        }
        // The operator is mid-sentence in there — but "mid-sentence" can also
        // mean text that was typed and never submitted (a chat message whose
        // Enter was refused), and then this wait never ends: the agent is
        // never nudged again and every message piles up as "coalesced" while
        // nothing says so (21/08, six agents deaf at once). Waiting is still
        // right — typing into his half-written line is worse — so the fix is
        // to SAY it, once per stall, with what is holding it.
        if (!this.heldByComposer.has(name) && this.store.unreadCount(name) > 0) {
          this.heldByComposer.add(name);
          this.log.warn(
            `[dispatcher] holding nudges for ${name}: its pane has unsent text in the prompt ` +
              `(${this.store.unreadCount(name)} message(s) waiting). Submit or clear that line — ` +
              `the dashboard offers both on the agent's chat.`,
          );
        }
        continue;
      }
      this.heldByComposer.delete(name);
      this.composerHold.delete(name);
      if (this.store.unreadCount(name) === 0) {
        // Spec: only nudge with unread > 0. The debt is DISCHARGED (agent
        // read everything via check_messages) — drop the entry, otherwise it
        // leaks forever and re-fires a duplicate nudge on a later message.
        this.pendingNudge.delete(name);
        continue;
      }
      this.pendingNudge.delete(name);
      this.fireNudge(agent);
    }
  }

  /**
   * Status polling (PRD 10.4): hasSession per agent every
   * agentPollIntervalMs; updates status and emits agent_updated ONLY on
   * change. An agent that comes online with unread > 0 may be nudged,
   * respecting the cooldown (nudge now, or join the pending set).
   */
  async pollOnce(): Promise<void> {
    if (this.pollInFlight) return;
    this.pollInFlight = true;
    try {
      for (const { name, tmuxSession } of this.store.listAgents()) {
        let alive = false;
        try {
          alive = await this.tmux.hasSession(tmuxSession);
        } catch {
          alive = false; // fail-closed: unreadable tmux = not alive
        }
        const next: AgentStatus = alive ? "online" : "offline";
        // Re-read after the await: join/guard may have changed the agent.
        const agent = this.store.getAgent(name);
        if (!agent || agent.status === next) continue;

        // Flap breaker: an agent whose last nudge failed (guard abort — the
        // classic "session alive, pane on a shell" case) is NOT promoted back
        // to online until its pane passes the guard again. Otherwise every
        // poll cycle would flip it online, re-attempt the doomed nudge, abort
        // and flip it offline — unbounded SSE/log noise (PRD 10.3 vs 10.4).
        if (next === "online" && this.nudgeBlocked.has(name)) {
          let safe = false;
          try {
            safe = await this.tmux.isPaneSafeToNudge(tmuxSession);
          } catch {
            safe = false; // fail-closed
          }
          if (!safe) continue; // stays offline, no event, no nudge attempt
          this.nudgeBlocked.delete(name);
        }

        const updated = this.store.updateAgent(name, { status: next });
        this.bus.emit({ type: "agent_updated", payload: toPublicAgent(updated) });
        this.log.info(
          `[dispatcher] polling: ${name} became ${next} (tmux ${tmuxSession}).`,
        );

        if (next === "online" && !updated.muted && this.store.unreadCount(name) > 0) {
          if (this.inCooldown(updated)) {
            this.pendingNudge.add(name);
          } else {
            this.pendingNudge.delete(name);
            this.fireNudge(updated);
          }
        }
      }
    } finally {
      this.pollInFlight = false;
    }
  }

  /**
   * Manual nudge (dashboard button — PRD 10.1: "force a manual nudge").
   * Interpretation of "force" documented here on purpose: it BYPASSES the
   * cooldown and the mute flag (both are politeness/delivery controls that
   * the human operator may override), but NEVER the pane-command guard —
   * that one is a security invariant (PRD 10.3, section 15, pitfall P2) and
   * is not negotiable on any code path.
   */
  async forceNudge(name: string): Promise<ManualNudgeResult> {
    const agent = this.store.getAgent(name);
    if (!agent) {
      return { sent: false, reason: `unknown agent: "${name}"` };
    }
    return this.performNudge(agent);
  }

  /** Snapshot of the coalescing set (tests/debug). */
  get pendingAgents(): string[] {
    return [...this.pendingNudge];
  }

  /** Starts the flush (5s), status-polling and activity timers. Idempotent. */
  start(): void {
    if (this.flushTimer || this.pollTimer) return;
    this.flushTimer = setInterval(() => this.flushPending(), this.flushIntervalMs);
    this.flushTimer.unref(); // never hold the process open
    this.pollTimer = setInterval(() => {
      void this.pollOnce().catch((err) => {
        this.log.error(`[dispatcher] error in status polling:`, err);
      });
    }, this.config.agentPollIntervalMs);
    this.pollTimer.unref();
    // Idle vs working needs a livelier cadence than the 10s status poll — a
    // turn can start and finish inside one status interval — so it runs on its
    // own faster timer. It is cheap: one capture-pane of a few lines per online
    // agent.
    this.activityTimer = setInterval(() => {
      void this.refreshActivityOnce().catch((err) => {
        this.log.error(`[dispatcher] error in activity polling:`, err);
      });
    }, ACTIVITY_POLL_INTERVAL_MS);
    this.activityTimer.unref();
    // Immediate first poll so status converges right after boot (replay may
    // have loaded agents whose sessions are still alive).
    void this.pollOnce().catch((err) => {
      this.log.error(`[dispatcher] error in initial polling:`, err);
    });
  }

  /** Stops all timers. Safe to call multiple times; no dangling handles. */
  stop(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.activityTimer) clearInterval(this.activityTimer);
    this.flushTimer = undefined;
    this.pollTimer = undefined;
    this.activityTimer = undefined;
  }

  /**
   * Idle-vs-working sweep: for each ONLINE agent, read a few lines of its pane
   * and flip `activity` when it crosses the working/idle line. Best-effort and
   * change-only (emits + persists solely on a transition), so a steadily busy
   * or steadily idle agent costs one capture and no writes. Offline agents are
   * left as the status poll set them (idle).
   */
  async refreshActivityOnce(): Promise<void> {
    if (this.activityInFlight) return;
    if (!this.tmux.capturePane) return; // test mock without pane access
    this.activityInFlight = true;
    try {
      for (const { name, tmuxSession } of this.store.listAgents()) {
        const agent = this.store.getAgent(name);
        if (!agent || agent.status !== "online") continue;
        let status: PaneStatus = { working: false, blocked: false, queued: false, spinner: null, headsUp: null, composerBusy: false, composerText: "", composerWrapped: false, outputTokens: null, subagents: [], blockedPrompt: null, blockedOptions: [], waitingFor: null, permission: null, goalActive: false, goalFor: null };
        try {
          status = parsePaneStatus(await this.tmux.capturePane(tmuxSession, 30, true));
        } catch {
          /* unreadable pane: treat as idle/unknown, never throw */
        }
        const next: AgentActivity = status.working ? "working" : "idle";
        const blocked = status.blocked;
        const composerBusy = status.composerBusy;
        const composerText = status.composerText;
        const subagents = status.subagents;
        // Writing or thinking? The frame looks identical either way — the CLI
        // spins the same way for both — so the answer is whether the output
        // counter MOVED since the last sweep. No counter, no claim.
        const seen = this.lastOutputTokens.get(name);
        const tokens = status.outputTokens;
        let phase: AgentPhase | undefined;
        if (next === "working" && tokens !== null) {
          phase = seen !== undefined && tokens > seen ? "speaking" : "thinking";
        }
        if (tokens === null) this.lastOutputTokens.delete(name);
        else this.lastOutputTokens.set(name, tokens);
        const blockedPrompt = status.blockedPrompt ?? "";
        const blockedOptions = status.blockedOptions;
        // Only write on a real change (any field), so a steady agent is free.
        const permission = status.permission ?? agent.permission;
        const goalFor = status.goalActive ? status.goalFor ?? undefined : undefined;
        // "" (not undefined) when nothing is pending: updateAgent IGNORES
        // undefined keys, so undefined could set the field but never clear it.
        const waitingFor = status.waitingFor ?? "";
        // A note the screen cut short: its full text, and the keys of its
        // state when they scrolled away, from Claude Code's own store.
        let headsUp = status.headsUp;
        if (headsUp && this.headsUpLookup) {
          let full: { detail: string[]; kind: string } | null = null;
          try {
            full = this.headsUpLookup(headsUp.text);
          } catch {
            full = null;
          }
          if (full) {
            headsUp = {
              text: headsUp.text,
              detail: full.detail.length ? full.detail : headsUp.detail,
              options: headsUp.options.length ? headsUp.options : defaultHeadsUpKeys(full.kind),
            };
          }
        }
        // The turn's start, from the CLI's OWN clock ("23s" into it) placed on
        // the hub's: the chat's live line counts from here. Kept while it
        // agrees within a few seconds, so a steady turn writes nothing.
        let turnStartedAt = "";
        let spinnerVerb = "";
        let spinnerNote = "";
        if (status.spinner) {
          const start = this.now() - status.spinner.seconds * 1000;
          const known = agent.turnStartedAt ? Date.parse(agent.turnStartedAt) : NaN;
          turnStartedAt = !Number.isNaN(known) && Math.abs(known - start) < 5000 ? agent.turnStartedAt! : new Date(start).toISOString();
          spinnerVerb = status.spinner.verb;
          spinnerNote = status.spinner.note;
        } else if (status.working && agent.turnStartedAt) {
          turnStartedAt = agent.turnStartedAt; // a frame without the line keeps what we had
          spinnerVerb = agent.spinnerVerb ?? "";
          spinnerNote = agent.spinnerNote ?? "";
        }
        if (
          agent.activity === next &&
          !!agent.queued === status.queued &&
          (agent.turnStartedAt ?? "") === turnStartedAt &&
          (agent.spinnerVerb ?? "") === spinnerVerb &&
          (agent.spinnerNote ?? "") === spinnerNote &&
          JSON.stringify(agent.headsUp ?? null) === JSON.stringify(headsUp) &&
          agent.permission === permission &&
          !!agent.goalActive === status.goalActive &&
          (agent.goalFor ?? undefined) === goalFor &&
          (agent.waitingFor ?? "") === waitingFor &&
          !!agent.blocked === blocked &&
          !!agent.composerBusy === composerBusy &&
          (agent.phase ?? undefined) === phase &&
          (agent.composerText ?? "") === composerText &&
          (agent.blockedPrompt ?? "") === blockedPrompt &&
          (agent.blockedOptions ?? []).join("|") === blockedOptions.join("|") &&
          JSON.stringify(agent.subagents ?? []) === JSON.stringify(subagents)
        ) {
          continue;
        }
        const updated = this.store.updateAgent(name, {
          activity: next,
          phase,
          blocked,
          queued: status.queued,
          turnStartedAt,
          spinnerVerb,
          spinnerNote,
          headsUp, // null clears it: updateAgent skips only undefined
          composerBusy,
          composerText,
          blockedPrompt,
          blockedOptions,
          subagents,
          waitingFor,
          permission,
          goalActive: status.goalActive,
          goalFor,
        });
        this.bus.emit({ type: "agent_updated", payload: toPublicAgent(updated) });
      }
    } finally {
      this.activityInFlight = false;
    }
  }

  // ------------------------------------------------------------------ internals

  private inCooldown(agent: Agent): boolean {
    if (!agent.lastNudgeAt) return false;
    const last = Date.parse(agent.lastNudgeAt);
    if (Number.isNaN(last)) return false;
    return this.now() - last < this.config.nudgeCooldownMs;
  }

  /**
   * Borrows the composer line, delivers the nudge, puts the line back.
   *
   * Only ever reached after COMPOSER_HOLD_LIMIT_MS of the SAME text sitting
   * untouched, and it re-reads the pane live before touching anything — if the
   * text moved between the flush and this moment, the operator is writing and
   * the rescue steps aside. Everything else is fail-closed too: a wrapped (or
   * multi-line) composer is never borrowed, because only the prompt line can
   * be read back and restoring half a sentence would be worse than waiting; a
   * pane that will not clear is left exactly as it was; and the operator's
   * text is typed back WITHOUT Enter — his words are his to send.
   */
  private borrowComposerAndNudge(agent: Agent, expected: string): void {
    const { sendKeysHex, sendKeysLiteral, capturePane } = this.tmux;
    if (!sendKeysHex || !sendKeysLiteral || !capturePane) return; // test mocks
    if (this.rescuing.has(agent.name)) return;
    this.rescuing.add(agent.name);
    void (async () => {
      try {
        const live = parsePaneStatus(await capturePane(agent.tmuxSession, 30, true));
        if (live.blocked || live.working) return; // not a moment to type
        if (live.composerText !== expected || !live.composerBusy) return; // it moved
        if (live.composerWrapped) {
          this.log.warn(
            `[dispatcher] cannot free ${agent.name}'s prompt automatically: the unsent text ` +
              `spans more than the prompt line, and restoring half of it would lose the rest. ` +
              `Send or clear it from the dashboard.`,
          );
          return;
        }
        // The text goes in the log BEFORE anything is erased. Everything below
        // is written to fail closed, but "closed" must never mean "his sentence
        // is gone with no record of it".
        this.log.info(`[dispatcher] ${agent.name}'s unsent prompt text, saved before the rescue: ${JSON.stringify(expected)}`);
        // Erase it: backspaces are what these TUIs honour (Ctrl-U, Escape and
        // Ctrl-A/Ctrl-K do nothing — all four measured on a live pane). Extra
        // ones are harmless: backspace stops at the start of the line. The
        // margin is generous because one grapheme is not always one backspace.
        await sendKeysHex(agent.tmuxSession, Buffer.alloc(expected.length + 8, 0x7f));
        // …and then WAIT before believing the screen. These TUIs do not repaint
        // the composer the instant it empties (measured: a pane still showed
        // the old line a full second after the backspaces landed, and only
        // repainted when the next key arrived), so a single immediate read
        // reports "still busy" for a line that is already gone — and that read
        // is what decides whether his text gets typed back.
        let after = parsePaneStatus(await capturePane(agent.tmuxSession, 30, true));
        for (let i = 0; i < 3 && after.composerBusy; i++) {
          await this.sleep(400);
          after = parsePaneStatus(await capturePane(agent.tmuxSession, 30, true));
        }
        if (after.composerBusy) {
          this.log.warn(
            `[dispatcher] could not clear ${agent.name}'s prompt (still holding text after ` +
              `the backspaces); leaving it untouched — its text is in the line above.`,
          );
          return;
        }
        this.log.info(
          `[dispatcher] borrowed ${agent.name}'s prompt to deliver a nudge held for ` +
            `${Math.round(COMPOSER_HOLD_LIMIT_MS / 1000)}s; its unsent line is restored after.`,
        );
        await this.performNudge(agent);
      } catch (err) {
        this.log.error(`[dispatcher] rescue failed for ${agent.name}:`, err);
      } finally {
        // ALWAYS give the line back, whatever happened above — including a
        // throw between the erase and the nudge. Never with an Enter.
        try {
          const now = parsePaneStatus(await capturePane!(agent.tmuxSession, 30, true));
          if (!now.composerBusy && expected) await sendKeysLiteral!(agent.tmuxSession, expected);
        } catch (err) {
          this.log.error(`[dispatcher] could not restore ${agent.name}'s prompt text:`, err);
        }
        this.composerHold.delete(agent.name);
        this.heldByComposer.delete(agent.name);
        this.rescuing.delete(agent.name);
      }
    })();
  }

  /** Fire-and-forget wrapper: the decision paths must never await tmux. */
  private fireNudge(agent: Agent): void {
    void this.performNudge(agent).catch((err) => {
      this.log.error(`[dispatcher] unexpected error nudging ${agent.name}:`, err);
    });
  }

  /**
   * sendNudge from the PRD 10.2 pseudocode. The prefix up to the first await
   * runs SYNCHRONOUSLY at the call site: the nudge text is composed and
   * lastNudgeAt is stamped before control returns, so bursts arriving in the
   * same tick already see the cooldown (that is what coalesces them).
   * The text is the EXACT template from 10.2, always one line (P5), and
   * NEVER includes the message body.
   */
  private async performNudge(agent: Agent): Promise<ManualNudgeResult> {
    const unread = this.store.unreadCount(agent.name);
    const froms = this.store.unreadSenders(agent.name).join(", ");
    // unread === 0 is only reachable via forceNudge (every automatic path
    // gates on unread > 0): the count/senders template would degenerate into
    // "0 new message(s) from: ." — use a purpose-built manual-poke line.
    const text = (
      unread === 0
        ? `[switchboard] Manual nudge from operator. Use the check_messages tool to check your queue.`
        : `[switchboard] ${unread} new message(s) from: ${froms}. ` +
          `Use the check_messages tool to read them.`
    ).replace(/[\r\n]+/g, " "); // a nudge is ALWAYS a single line (P5)
    const at = new Date(this.now()).toISOString();
    // Stamp SYNCHRONOUSLY (same-tick bursts must already see the cooldown —
    // that is what coalesces them), but remember the previous value: a nudge
    // that ends up typing NOTHING must not impose a 15s cooldown on the
    // recovery path (PRD 10.2 stamps only after a successful send).
    const prevNudgeAt = agent.lastNudgeAt;
    this.store.updateAgent(agent.name, { lastNudgeAt: at });

    // LIVE re-check right before typing: the cached `blocked` flag is up to
    // one activity poll old, and a modal that opened in between would eat
    // this nudge's Enter as its answer. Fail-CLOSED — an unreadable pane is
    // treated as blocked, exactly like the pane guard.
    if (this.tmux.capturePane) {
      let live: PaneStatus = { working: false, blocked: true, queued: false, spinner: null, headsUp: null, composerBusy: true, composerText: "", composerWrapped: true, outputTokens: null, subagents: [], blockedPrompt: null, blockedOptions: [], waitingFor: null, permission: null, goalActive: false, goalFor: null };
      try {
        live = parsePaneStatus(await this.tmux.capturePane(agent.tmuxSession, 30, true));
      } catch {
        /* unreadable → stay blocked AND busy: fail closed on both */
      }
      if (live.blocked || live.composerBusy) {
        const why = live.blocked
          ? "a modal dialog owns the pane (typing now would answer it)"
          : "the operator is mid-sentence in that pane (typing now would land inside the prompt)";
        this.store.updateAgent(agent.name, {
          lastNudgeAt: prevNudgeAt,
          blocked: live.blocked,
          composerBusy: live.composerBusy,
        });
        this.pendingNudge.add(agent.name); // delivered once the pane is free
        this.log.info(`[dispatcher] nudge for ${agent.name} HELD: ${why}. Queued for the next flush.`);
        return { sent: false, reason: why };
      }
    }

    let result: NudgeResult;
    try {
      result = await this.tmux.nudgeSession(
        agent.tmuxSession,
        text,
        this.config.nudgeEnterDelayMs,
      );
    } catch (err) {
      result = { sent: false, reason: `error running tmux: ${String(err)}` };
    }

    if (result.sent) {
      this.nudgeBlocked.delete(agent.name);
      this.bus.emit({ type: "nudge_sent", payload: { agent: agent.name, at, unread } });
      this.log.info(
        `[dispatcher] nudge sent to ${agent.name} (${unread} unread from: ${froms}).`,
      );
      return { sent: true };
    }

    // Guard abort or tmux failure: the nudge did NOT complete. PRD 10.3:
    // mark the agent offline, quarantine it (see nudgeBlocked) and log at
    // warn level. Revert the optimistic cooldown stamp (only if no other
    // nudge re-stamped it meanwhile) so delivery is not delayed by up to 15s
    // once the agent actually recovers.
    const reason = result.reason ?? "unknown reason";
    this.log.warn(`[dispatcher] nudge to ${agent.name} ABORTED: ${reason}.`);
    this.nudgeBlocked.add(agent.name);
    const current = this.store.getAgent(agent.name);
    if (current && current.lastNudgeAt === at) {
      this.store.updateAgent(agent.name, { lastNudgeAt: prevNudgeAt });
    }
    this.markOffline(agent.name); // emitted payload already carries the reverted stamp
    return { sent: false, reason };
  }

  /** Sets status=offline, emitting agent_updated only when it changes. */
  private markOffline(name: string): void {
    const agent = this.store.getAgent(name);
    if (!agent || agent.status === "offline") return;
    const updated = this.store.updateAgent(name, { status: "offline" });
    this.bus.emit({ type: "agent_updated", payload: toPublicAgent(updated) });
  }
}
