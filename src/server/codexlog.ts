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

/** Every rollout file under the sessions tree, newest mtime first. */
function listRollouts(sessionsDir: string): string[] {
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
  return out.sort((a, b) => b.mtime - a.mtime).map((e) => e.file);
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
  windowMinutes: number;
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
 * Sum of Codex tokens spent TODAY — Codex has no usage-limit API (it's OpenAI),
 * but its rollouts carry token_count events whose info.total_token_usage is the
 * running total for that session. Summing the LAST token_count of each of the
 * day's rollouts gives "tokens across today's Codex sessions". `now` picks the
 * date folder (YYYY/MM/DD); a missing folder → zeros.
 */
export function codexTokensToday(now: Date, sessionsDir = codexSessionsDir()): CodexTokens {
  const { total, input, output, reasoning } = codexUsageSnapshot(now, sessionsDir);
  return { total, input, output, reasoning };
}

/**
 * Today's token detail plus the NEWEST Codex plan windows. The latter are the
 * useful answer to “how much Codex do I have left?” and are already present in
 * local rollouts — no OpenAI credential or extra network request is needed.
 */
export function codexUsageSnapshot(now: Date, sessionsDir = codexSessionsDir()): CodexUsageSnapshot {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const dayDir = path.join(sessionsDir, String(y), m, d);
  const acc: CodexTokens = { total: 0, input: 0, output: 0, reasoning: 0 };
  let files: { name: string; mtime: number }[];
  try {
    files = fs.readdirSync(dayDir)
      .filter((f) => f.startsWith("rollout-") && f.endsWith(".jsonl"))
      .map((name) => {
        try {
          return { name, mtime: fs.statSync(path.join(dayDir, name)).mtimeMs };
        } catch {
          return { name, mtime: 0 };
        }
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return { ...acc, limits: [], planType: null, limitId: null, limitName: null, updatedAt: null };
  }
  let latestRate: RawRateLimits | null = null;
  let latestRateMtime = 0;
  for (const file of files) {
    const last = lastTokenEvent(path.join(dayDir, file.name));
    if (last.tokens) {
      acc.total += last.tokens.total;
      acc.input += last.tokens.input;
      acc.output += last.tokens.output;
      acc.reasoning += last.tokens.reasoning;
    }
    if (!latestRate && last.rateLimits) {
      latestRate = last.rateLimits;
      latestRateMtime = file.mtime;
    }
  }
  return {
    ...acc,
    limits: latestRate ? normalizeCodexLimits(latestRate) : [],
    planType: typeof latestRate?.plan_type === "string" ? latestRate.plan_type : null,
    limitId: typeof latestRate?.limit_id === "string" ? latestRate.limit_id : null,
    limitName: typeof latestRate?.limit_name === "string" ? latestRate.limit_name : null,
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

function normalizeCodexLimits(raw: RawRateLimits): CodexUsageLimit[] {
  const out: CodexUsageLimit[] = [];
  for (const id of ["primary", "secondary"] as const) {
    const win = raw[id];
    if (!win) continue;
    if (
      typeof win.used_percent !== "number" || !Number.isFinite(win.used_percent) ||
      typeof win.window_minutes !== "number" || !Number.isFinite(win.window_minutes)
    ) continue;
    const epoch = typeof win.resets_at === "number"
      ? win.resets_at * 1000
      : typeof win.resets_at === "string"
        ? Date.parse(win.resets_at)
        : NaN;
    if (!Number.isFinite(epoch)) continue;
    out.push({
      id,
      usedPercent: win.used_percent,
      windowMinutes: win.window_minutes,
      resetsAt: new Date(epoch).toISOString(),
    });
  }
  return out;
}

/** Last cumulative tokens and newest rate_limits carried by a rollout. */
function lastTokenEvent(file: string): { tokens: CodexTokens | null; rateLimits: RawRateLimits | null } {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { tokens: null, rateLimits: null };
  }
  let tokens: CodexTokens | null = null;
  let rateLimits: RawRateLimits | null = null;
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"token_count"')) continue;
    try {
      const rec = JSON.parse(line) as {
        payload?: {
          type?: string;
          info?: { total_token_usage?: Record<string, unknown> };
          rate_limits?: RawRateLimits;
        };
      };
      if (rec.payload?.type !== "token_count") continue;
      if (!rateLimits && rec.payload.rate_limits) rateLimits = rec.payload.rate_limits;
      const u = rec.payload.info?.total_token_usage;
      if (!tokens && u) {
        const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
        tokens = {
          total: num(u.total_tokens),
          input: num(u.input_tokens),
          output: num(u.output_tokens),
          reasoning: num(u.reasoning_output_tokens),
        };
      }
      if (tokens && rateLimits) break;
    } catch {
      /* malformed — keep scanning upward */
    }
  }
  return { tokens, rateLimits };
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
