// Codex CLI's conversation log — the chat casca's data source for a codex
// agent, mirroring what conversation.ts does for Claude Code.
//
// Codex stores each thread as a "rollout": newline-delimited JSON under
// ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl (or $CODEX_HOME).
// Unlike Claude's per-project directory, the tree is date-keyed, so a cwd
// cannot be turned into a path — the locator SCANS newest-first and matches
// the first line's session_meta.payload.cwd. Verified live on codex-cli
// 0.144.5 (the interactive TUI writes the same rollout as `codex exec`).
//
// Line shapes actually observed (0.144.5):
//   {type:"session_meta",  payload:{ id, cwd, ... }}                — first line
//   {type:"event_msg",     payload:{ type:"user_message",  message }}
//   {type:"event_msg",     payload:{ type:"agent_message", message }}
//   {type:"response_item", payload:{ type:"message", role, content:[...] }}
//     — duplicates the event_msg text and carries injected developer/env
//       context, so it is deliberately NOT parsed for chat text.
//   {type:"response_item", payload:{ type:"custom_tool_call",
//     call_id, name, input }}
//   {type:"response_item", payload:{ type:"custom_tool_call_output",
//     call_id, output:[{text}...] }}
//   {type:"response_item", payload:{ type:"reasoning", summary:[...],
//     encrypted_content }} — usually encrypted; only readable summaries render.
// Everything else (world_state, turn_context, token_count, …) is skipped.
// A malformed line is skipped, never thrown — the file is appended live.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChatItem, ToolItem } from "./conversation.js";

/** ~/.codex/sessions, honouring $CODEX_HOME like the CLI does. */
export function codexSessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.CODEX_HOME && env.CODEX_HOME.trim() !== "" ? env.CODEX_HOME : path.join(os.homedir(), ".codex");
  return path.join(home, "sessions");
}

/** Every rollout file under the sessions tree with its mtime, newest first. */
function listRolloutsWithMtime(sessionsDir: string): { file: string; mtime: number }[] {
  const out: { file: string; mtime: number }[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // missing/unreadable dir: no rollouts here
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) {
        try {
          out.push({ file: p, mtime: fs.statSync(p).mtimeMs });
        } catch {
          /* raced a deletion — skip */
        }
      }
    }
  };
  walk(sessionsDir);
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** Every rollout file under the sessions tree, newest mtime first. */
function listRollouts(sessionsDir: string): string[] {
  return listRolloutsWithMtime(sessionsDir).map((e) => e.file);
}

/** Reads the HEAD of a file (the start of the session_meta first line). */
function firstChunk(file: string, maxBytes = 16_384): string | null {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(maxBytes);
    const n = fs.readSync(fd, buf, 0, maxBytes, 0);
    return buf.toString("utf8", 0, n);
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Pulls session_meta's cwd out of a rollout's head WITHOUT parsing the whole
 * first line: the real session_meta embeds the CLI's entire base_instructions
 * text, ballooning that line past any sane read cap (observed >16 KB on
 * 0.144.5), so JSON.parse-of-the-line is a trap. The cwd field sits in the
 * payload's first ~200 bytes; a regex on the head is robust to line length.
 */
export function cwdOfRolloutHead(head: string): string | null {
  if (!/"type"\s*:\s*"session_meta"/.test(head)) return null;
  const m = head.match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!m) return null;
  try {
    return JSON.parse(`"${m[1]}"`) as string; // unescape \uXXXX, \\, \" …
  } catch {
    return null;
  }
}

/**
 * The agent's CURRENT codex thread: the newest rollout whose session_meta.cwd
 * matches the agent's cwd. Null when none exists yet (a fresh codex agent has
 * no rollout until its first turn).
 */
export function findCodexRolloutForCwd(cwd: string, sessionsDir = codexSessionsDir()): string | null {
  for (const file of listRollouts(sessionsDir)) {
    const head = firstChunk(file);
    if (!head) continue;
    if (cwdOfRolloutHead(head) === cwd) return file;
  }
  return null;
}

export interface CodexTokens {
  total: number;
  input: number;
  output: number;
  reasoning: number;
}

export interface CodexUsageLimit {
  id: "primary" | "secondary";
  usedPercent: number;
  /** Window length; null when the event did not carry it (percent + reset suffice). */
  windowMinutes: number | null;
  resetsAt: string;
}

/** Real plan-window data emitted by Codex's own token_count events. */
export interface CodexUsageSnapshot extends CodexTokens {
  limits: CodexUsageLimit[];
  planType: string | null;
  limitId: string | null;
  limitName: string | null;
  updatedAt: string | null;
}

/**
 * Codex tokens spent TODAY — Codex has no usage-limit API (it's OpenAI), but
 * its rollouts carry token_count events whose info.total_token_usage is the
 * running total for that session. See codexUsageSnapshot for how "today" is
 * cut out of a session that started on an earlier day.
 */
export function codexTokensToday(now: Date, sessionsDir = codexSessionsDir()): CodexTokens {
  const { total, input, output, reasoning } = codexUsageSnapshot(now, sessionsDir);
  return { total, input, output, reasoning };
}

/** How much of a big rollout is read from the end before falling back to all of it. */
const TAIL_BYTES = 256 * 1024;
/** How many of the newest rollouts are searched for a windowed rate limit. */
const RATE_SEARCH_FILES = 10;

/**
 * Today's token detail plus the NEWEST Codex plan windows. The latter are the
 * fallback answer to “how much Codex do I have left?” when the live read
 * (codex-ratelimits.ts) is unavailable — no OpenAI credential needed.
 */
export function codexUsageSnapshot(now: Date, sessionsDir = codexSessionsDir()): CodexUsageSnapshot {
  // "Today's usage" is every rollout WRITTEN today, decided by mtime — NOT by
  // the date folder it is filed under. Codex files a rollout under the date its
  // session STARTED and then keeps appending to that same file for days, so a
  // long-lived session's live rollout sits under an old date directory. Reading
  // only today's folder made a Codex agent that had been running since an
  // earlier day report all zeros: nothing new is filed under today, while its
  // real usage keeps flowing into the old file (bug, 11/09 — a session started
  // 09-08 was still active, and the 09-11 folder was empty).
  //
  // And a rollout written today is not ALL today's usage: its cumulative total
  // includes every earlier day of that session. Summing the raw last total
  // overcounted a multi-day session by its whole history, so each file
  // contributes (last total) − (last total stamped before local midnight).
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const endOfDay = startOfDay + 24 * 60 * 60 * 1000;
  const acc: CodexTokens = { total: 0, input: 0, output: 0, reasoning: 0 };
  const all = listRolloutsWithMtime(sessionsDir); // newest first
  for (const file of all) {
    if (file.mtime < startOfDay || file.mtime >= endOfDay) continue;
    const today = tokensTodayOf(file.file, startOfDay);
    acc.total += today.total;
    acc.input += today.input;
    acc.output += today.output;
    acc.reasoning += today.reasoning;
  }
  // Plan windows come from the newest rollout of ANY date: they describe the
  // account, not the day, and an idle day must not blank the bars. A window
  // whose reset has passed is reported as 0% (see normalizeCodexLimits).
  let latestRate: RawRateLimits | null = null;
  let latestRateMtime = 0;
  let anyRate: RawRateLimits | null = null;
  for (const file of all.slice(0, RATE_SEARCH_FILES)) {
    const rl = rateLimitsOf(file.file);
    if (!anyRate && rl.any) anyRate = rl.any;
    if (rl.windowed) {
      latestRate = rl.windowed;
      latestRateMtime = file.mtime;
      break;
    }
  }
  const rate = latestRate ?? anyRate;
  return {
    ...acc,
    limits: latestRate ? normalizeCodexLimits(latestRate, now.getTime()) : [],
    planType: typeof rate?.plan_type === "string" ? rate.plan_type : null,
    limitId: typeof rate?.limit_id === "string" ? rate.limit_id : null,
    limitName: typeof rate?.limit_name === "string" ? rate.limit_name : null,
    updatedAt: latestRateMtime > 0 ? new Date(latestRateMtime).toISOString() : null,
  };
}

interface RawRateWindow {
  used_percent?: unknown;
  window_minutes?: unknown;
  resets_at?: unknown;
}

interface RawRateLimits {
  limit_id?: unknown;
  limit_name?: unknown;
  primary?: RawRateWindow | null;
  secondary?: RawRateWindow | null;
  plan_type?: unknown;
}

/**
 * A window needs only a finite used_percent and a parseable resets_at; the
 * duration is optional. A window whose reset is already behind `nowMs` has
 * rolled over since the event was written, so it reads 0% — a rollout from
 * yesterday otherwise keeps shouting "99%" at a fresh window.
 */
export function normalizeCodexLimits(raw: RawRateLimits, nowMs = Date.now()): CodexUsageLimit[] {
  const out: CodexUsageLimit[] = [];
  for (const id of ["primary", "secondary"] as const) {
    const win = raw[id];
    if (!win) continue;
    if (typeof win.used_percent !== "number" || !Number.isFinite(win.used_percent)) continue;
    const epoch = typeof win.resets_at === "number"
      ? win.resets_at * 1000
      : typeof win.resets_at === "string"
        ? Date.parse(win.resets_at)
        : NaN;
    if (!Number.isFinite(epoch)) continue;
    const mins = win.window_minutes;
    out.push({
      id,
      usedPercent: epoch <= nowMs ? 0 : win.used_percent,
      windowMinutes: typeof mins === "number" && Number.isFinite(mins) && mins > 0 ? mins : null,
      resetsAt: new Date(epoch).toISOString(),
    });
  }
  return out;
}

/**
 * The end of a file: at most `maxBytes`, with the (probably cut) first line
 * dropped when the read did not start at 0. `whole` tells the caller whether
 * nothing was left unread.
 */
function readTail(file: string, maxBytes = TAIL_BYTES): { text: string; whole: boolean } | null {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    const n = fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString("utf8", 0, n);
    if (start > 0) {
      const nl = text.indexOf("\n");
      text = nl === -1 ? "" : text.slice(nl + 1);
    }
    return { text, whole: start === 0 };
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function readWhole(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

interface TokenScan {
  /** Newest cumulative total in the text. */
  last: CodexTokens | null;
  /** Newest cumulative total stamped BEFORE the cutoff (the day's baseline). */
  before: CodexTokens | null;
  windowed: RawRateLimits | null;
  any: RawRateLimits | null;
}

const ZERO: CodexTokens = { total: 0, input: 0, output: 0, reasoning: 0 };

/** Walks token_count lines newest-first; `cutoff` is local midnight in ms. */
function scanTokenCounts(text: string, cutoff: number): TokenScan {
  const scan: TokenScan = { last: null, before: null, windowed: null, any: null };
  // Two rate candidates, because the LAST rate_limits is not always the useful
  // one: Codex's final few token_count events in a session often carry a
  // rate_limits whose primary/secondary windows are null (it still has the
  // plan_type, but no percentages). Taking that one blindly wiped the "Codex
  // X%" bars even though a slightly earlier event held real windows (bug,
  // 11/09 — the last 3 events were null while 173 before them reported the
  // primary at 99%). So we keep the freshest WINDOWED one for the bars, and the
  // freshest of any kind as a fallback so plan_type still comes through.
  const hasWindow = (r: RawRateLimits): boolean => r.primary != null || r.secondary != null;
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"token_count"')) continue;
    try {
      const rec = JSON.parse(line) as {
        timestamp?: unknown;
        payload?: {
          type?: string;
          info?: { total_token_usage?: Record<string, unknown> } | null;
          rate_limits?: RawRateLimits | null;
        };
      };
      if (rec.payload?.type !== "token_count") continue;
      const rl = rec.payload.rate_limits;
      if (rl) {
        if (!scan.any) scan.any = rl;
        if (!scan.windowed && hasWindow(rl)) scan.windowed = rl;
      }
      const u = rec.payload.info?.total_token_usage;
      if (u) {
        const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
        const tokens = {
          total: num(u.total_tokens),
          input: num(u.input_tokens),
          output: num(u.output_tokens),
          reasoning: num(u.reasoning_output_tokens),
        };
        if (!scan.last) scan.last = tokens;
        const ts = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : NaN;
        if (!scan.before && Number.isFinite(ts) && ts < cutoff) scan.before = tokens;
      }
      if (scan.last && scan.before && scan.windowed) break;
    } catch {
      /* malformed — keep scanning upward */
    }
  }
  return scan;
}

/** Timestamp of the rollout's first line (session start); NaN when unknown. */
function sessionStartOf(file: string): number {
  const head = firstChunk(file, 512);
  const m = head?.match(/^\{"timestamp"\s*:\s*"([^"]+)"/);
  return m ? Date.parse(m[1]) : NaN;
}

/**
 * One rollout's tokens spent since `startOfDay`. Reads only the tail when it
 * can: the baseline is either inside the tail, or provably zero because the
 * session itself started today. Otherwise (a session spanning midnight whose
 * last pre-midnight event is far back) the whole file is read once.
 */
function tokensTodayOf(file: string, startOfDay: number): CodexTokens {
  const tail = readTail(file);
  if (!tail) return ZERO;
  let scan = scanTokenCounts(tail.text, startOfDay);
  if (!scan.last) {
    if (tail.whole) return ZERO;
    const text = readWhole(file);
    if (text === null) return ZERO;
    scan = scanTokenCounts(text, startOfDay);
    if (!scan.last) return ZERO;
  } else if (!scan.before && !tail.whole) {
    const started = sessionStartOf(file);
    if (!(Number.isFinite(started) && started >= startOfDay)) {
      const text = readWhole(file);
      if (text !== null) scan = scanTokenCounts(text, startOfDay);
    }
  }
  const last = scan.last ?? ZERO;
  const base = scan.before ?? ZERO;
  const d = (a: number, b: number): number => Math.max(0, a - b);
  return {
    total: d(last.total, base.total),
    input: d(last.input, base.input),
    output: d(last.output, base.output),
    reasoning: d(last.reasoning, base.reasoning),
  };
}

/** Freshest windowed / any rate_limits in a rollout, tail first. */
function rateLimitsOf(file: string): { windowed: RawRateLimits | null; any: RawRateLimits | null } {
  const tail = readTail(file);
  if (!tail) return { windowed: null, any: null };
  let scan = scanTokenCounts(tail.text, -Infinity);
  if (!scan.windowed && !tail.whole) {
    const text = readWhole(file);
    if (text !== null) {
      const full = scanTokenCounts(text, -Infinity);
      scan = { ...full, any: scan.any ?? full.any };
    }
  }
  return { windowed: scan.windowed, any: scan.any };
}

/** One-line label for a codex tool call ("exec: const p = await …"). */
function codexToolSummary(name: string, input: unknown): string {
  const text = typeof input === "string" ? input : JSON.stringify(input ?? "");
  const head = (text || "").split("\n")[0].slice(0, 80);
  return head ? `${name}: ${head}` : name;
}

/** output: [{type, text}...] | string → plain text. */
function outputToText(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    return output
      .map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : ""))
      .join("");
  }
  return "";
}

/**
 * Parses rollout lines into the SAME ChatItem shape conversation.ts produces,
 * so the dashboard renders codex and claude chats with one code path.
 */
/**
 * Text out of a 26.x `item`: content is a list of parts, and the part shape
 * has varied across builds ({type:"Text"|"text", text}). Anything without
 * readable text (an image view, an encrypted reasoning blob) yields "".
 */
function codexItemText(item: { content?: unknown; text?: unknown }): string {
  if (typeof item.text === "string" && item.text.trim()) return item.text.trim();
  if (!Array.isArray(item.content)) return "";
  return item.content
    .map((part) =>
      part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? String((part as { text: string }).text)
        : "",
    )
    .join("")
    .trim();
}

export function parseCodexRollout(lines: string[]): ChatItem[] {
  const items: ChatItem[] = [];
  const toolsById = new Map<string, ToolItem>();

  for (const line of lines) {
    if (line.trim() === "") continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // half-written tail or corruption — skip, never crash
    }
    const ts = typeof rec.timestamp === "string" ? rec.timestamp : undefined;
    const p = rec.payload;
    if (!p || typeof p !== "object") continue;

    if (rec.type === "event_msg") {
      if (p.type === "user_message" && typeof p.message === "string" && p.message.trim()) {
        items.push({ kind: "user", text: p.message.trim(), ts });
      } else if (p.type === "agent_message" && typeof p.message === "string" && p.message.trim()) {
        items.push({ kind: "assistant", text: p.message.trim(), ts });
      } else if (p.type === "item_completed" && p.item && typeof p.item === "object") {
        // Codex CLI 26.x moved the conversation into item_completed:
        //   {type:"item_completed", item:{type:"AgentMessage"|"UserMessage",
        //                                 content:[{type:"Text", text}]}}
        // The old flat agent_message/user_message events are gone, which is
        // why the chat rendered nothing but tool chips for a codex agent
        // (the tool records live under response_item and never changed).
        // Both shapes are read: a rollout written by an older CLI still works.
        const item = p.item as { type?: unknown; content?: unknown; text?: unknown };
        const kind =
          item.type === "AgentMessage" ? "assistant" : item.type === "UserMessage" ? "user" : null;
        if (kind) {
          const text = codexItemText(item);
          if (text) items.push({ kind, text, ts });
        }
      }
      continue;
    }

    if (rec.type !== "response_item") continue;

    if ((p.type === "custom_tool_call" || p.type === "function_call") && (p.call_id || p.id)) {
      const id = String(p.call_id ?? p.id);
      const name = String(p.name ?? "tool");
      const input = p.input ?? p.arguments;
      const tool: ToolItem = {
        kind: "tool",
        id,
        name,
        summary: codexToolSummary(name, input),
        input,
        ts,
      };
      toolsById.set(id, tool);
      items.push(tool);
    } else if ((p.type === "custom_tool_call_output" || p.type === "function_call_output") && p.call_id) {
      const tool = toolsById.get(String(p.call_id));
      if (tool) {
        tool.result = outputToText(p.output).slice(0, 20_000);
        tool.isError = false; // codex rollouts don't flag errors distinctly
      }
    } else if (p.type === "reasoning" && Array.isArray(p.summary)) {
      // Reasoning is usually encrypted; only a readable summary is worth showing.
      const text = p.summary
        .map((s: unknown) => (s && typeof s === "object" && "text" in s ? String((s as { text: unknown }).text) : ""))
        .join("\n")
        .trim();
      if (text) items.push({ kind: "thinking", text, ts });
    }
  }
  return items;
}
