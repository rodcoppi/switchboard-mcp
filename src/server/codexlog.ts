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

/**
 * Sum of Codex tokens spent TODAY — Codex has no usage-limit API (it's OpenAI),
 * but its rollouts carry token_count events whose info.total_token_usage is the
 * running total for that session. Summing the LAST token_count of each of the
 * day's rollouts gives "tokens across today's Codex sessions". `now` picks the
 * date folder (YYYY/MM/DD); a missing folder → zeros.
 */
export function codexTokensToday(now: Date, sessionsDir = codexSessionsDir()): CodexTokens {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const dayDir = path.join(sessionsDir, String(y), m, d);
  const acc: CodexTokens = { total: 0, input: 0, output: 0, reasoning: 0 };
  let files: string[];
  try {
    files = fs.readdirSync(dayDir).filter((f) => f.startsWith("rollout-") && f.endsWith(".jsonl"));
  } catch {
    return acc; // no folder for today yet
  }
  for (const name of files) {
    const last = lastTokenUsage(path.join(dayDir, name));
    if (!last) continue;
    acc.total += last.total;
    acc.input += last.input;
    acc.output += last.output;
    acc.reasoning += last.reasoning;
  }
  return acc;
}

/** The last token_count's cumulative total_token_usage in a rollout, or null. */
function lastTokenUsage(file: string): CodexTokens | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"token_count"')) continue;
    try {
      const rec = JSON.parse(line) as {
        payload?: { type?: string; info?: { total_token_usage?: Record<string, unknown> } };
      };
      if (rec.payload?.type !== "token_count") continue;
      const u = rec.payload.info?.total_token_usage;
      if (!u) continue;
      const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
      return {
        total: num(u.total_tokens),
        input: num(u.input_tokens),
        output: num(u.output_tokens),
        reasoning: num(u.reasoning_output_tokens),
      };
    } catch {
      /* malformed — keep scanning upward */
    }
  }
  return null;
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
