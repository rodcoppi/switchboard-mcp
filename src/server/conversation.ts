// The agent's conversation, read from Claude Code's own log — the "chat casca":
// a clean rendered view of what the agent is doing, next to the raw terminal.
//
// Switchboard CONNECTS to agents it did not start, so it cannot get structured
// output by owning the process the way a wrapper would. It does not need to:
// Claude Code persists every message, tool call and result as JSONL under
// ~/.claude/projects/<encoded-cwd>/<session>.jsonl. Reading that log gives the
// clean chat WITHOUT owning the agent — the connector stays a connector, and
// the view is naturally read-only (you type in the terminal tab).
//
// This module is the pure parser: JSONL lines -> ordered chat items. Finding the
// file and tailing it live is the endpoint's job (api.ts).

import os from "node:os";
import path from "node:path";

/**
 * Claude Code's project-dir encoding: every non-alphanumeric character of the
 * absolute cwd becomes "-" (verified against real dirs: "/home/rod/ai panorama"
 * and "/home/rod/ai-panorama" both map to "-home-rod-ai-panorama"). The
 * collision is Claude Code's own and not ours to resolve.
 */
export function projectDirForCwd(cwd: string): string {
  return path.join(os.homedir(), ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
}

export interface UserItem {
  kind: "user";
  text: string;
  ts?: string;
}
export interface AssistantItem {
  kind: "assistant";
  text: string;
  /** The model that produced this turn (message.model), when present. */
  model?: string;
  ts?: string;
}
export interface ThinkingItem {
  kind: "thinking";
  text: string;
  ts?: string;
}
/**
 * A quiet centred line between turns — harness happenings the TERMINAL shows
 * but that are neither operator words nor agent prose: "worked for 2m 20s"
 * (turn_duration), a background task/monitor event (task-notification), the
 * away-summary. Without these the chat casca hid what the pane was showing.
 */
export interface MarkerItem {
  kind: "marker";
  text: string;
  ts?: string;
}
export interface ToolItem {
  kind: "tool";
  id: string;
  name: string;
  /** One-line label: "Bash: npm test", "Edit api.ts", "Read foo.ts". */
  summary: string;
  input: unknown;
  /** Filled when the matching tool_result line is seen. */
  result?: string;
  isError?: boolean;
  ts?: string;
}
export type ChatItem = UserItem | AssistantItem | ToolItem | ThinkingItem | MarkerItem;

/** 139866ms → "2m 20s"; 16228ms → "16s". Sub-second turns are not worth a line. */
export function fmtDurationMs(ms: number): string | null {
  const s = Math.round(ms / 1000);
  if (s < 1) return null;
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/**
 * A one-line label for a <task-notification> block (how monitor events and
 * background-task completions arrive in the transcript): the <summary> tag
 * when present, else the first line that is not tag machinery. Null when the
 * text is not a task notification at all.
 */
export function taskNotificationSummary(raw: string): string | null {
  if (!/<task-notification>/.test(raw)) return null;
  const summary = raw.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim();
  if (summary) return summary;
  const event = raw.match(/<event>([\s\S]*?)<\/event>/)?.[1]?.trim();
  if (event) return event;
  const line = raw
    .replace(/<[^>]+>/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "");
  return line ?? "background task update";
}

/** A short, human label for a tool call from its name and input. */
export function toolSummary(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const base = (p: string): string => (p ? p.split("/").pop() || p : "");
  switch (name) {
    case "Bash":
      return `Bash: ${str(i.command).split("\n")[0].slice(0, 80)}`;
    case "Read":
      return `Read ${base(str(i.file_path))}`;
    case "Edit":
    case "Write":
    case "NotebookEdit":
      return `${name} ${base(str(i.file_path ?? i.notebook_path))}`;
    case "Glob":
      return `Glob ${str(i.pattern)}`;
    case "Grep":
      return `Grep ${str(i.pattern).slice(0, 60)}`;
    case "Task":
      return `Task: ${str(i.description).slice(0, 60)}`;
    case "TodoWrite":
      return "Updated the plan";
    default:
      return name;
  }
}

/**
 * Cleans a user message for reading: strips the machinery Claude Code wraps
 * into the turn (system-reminders, slash-command metadata, local command
 * output) and returns "" for a message that was ONLY machinery — those are not
 * things the human said and would just be noise in the chat.
 */
export function cleanUserText(raw: string): string {
  let t = raw;
  // <system-reminder>…</system-reminder> — injected context, not user words.
  t = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");
  // Slash-command scaffolding and its captured stdout.
  t = t.replace(/<command-(name|message|args)>[\s\S]*?<\/command-\1>/g, "");
  t = t.replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, "");
  t = t.replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, "");
  // Harness notifications injected as user turns (task completions, etc.).
  t = t.replace(/<task-notification>[\s\S]*?<\/task-notification>/g, "");
  return t.trim();
}

/** tool_result content may be a string or an array of text blocks. */
function resultToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : ""))
      .join("");
  }
  return "";
}

/**
 * Parses conversation JSONL lines into an ordered list of chat items.
 *
 * What is kept: user text, assistant text, tool calls (with their results
 * matched by tool_use_id). What is dropped: meta/sidechain lines (Claude Code's
 * own bookkeeping and sub-agent traffic), and every non-message record type
 * (mode, permission-mode, agent-name, file-history-*, …) — noise for a reader.
 *
 * A malformed line is skipped, never thrown: the log is appended live and the
 * last line may be half-written when we read it.
 */
export function parseConversation(lines: string[]): ChatItem[] {
  const items: ChatItem[] = [];
  const toolsById = new Map<string, ToolItem>();

  for (const line of lines) {
    if (line.trim() === "") continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // half-written tail line, or corruption — skip, don't crash
    }
    if (rec.isMeta || rec.isSidechain) continue;
    const msg = rec.message;
    const ts = typeof rec.timestamp === "string" ? rec.timestamp : undefined;

    // A message sent WHILE the agent was mid-turn never becomes a type:"user"
    // record: the CLI queues it and the transcript gets queue-operation
    // bookkeeping plus ONE attachment record carrying the actual prompt
    // (attachment.type === "queued_command", the text in .prompt — verified on
    // a live transcript). Without this branch those messages simply never
    // rendered, which left their optimistic echo stuck on "sending…" forever.
    if (rec.type === "attachment") {
      const att = rec.attachment;
      if (att?.type === "queued_command" && typeof att.prompt === "string") {
        const text = cleanUserText(att.prompt);
        if (text) items.push({ kind: "user", text, ts });
        else {
          // A queued task-notification (monitor event etc.) is not operator
          // words, but the TERMINAL shows it — surface it as a marker line.
          const note = taskNotificationSummary(att.prompt);
          if (note) items.push({ kind: "marker", text: `task: ${note}`, ts });
        }
      }
      continue;
    }

    // Harness bookkeeping the terminal DOES show: surface the useful ones as
    // quiet markers instead of hiding them (the casca looked dead next to the
    // pane without them).
    if (rec.type === "system") {
      if (rec.subtype === "turn_duration" && typeof rec.durationMs === "number") {
        const d = fmtDurationMs(rec.durationMs);
        if (d) items.push({ kind: "marker", text: `worked for ${d}`, ts });
      } else if (rec.subtype === "away_summary" && typeof rec.content === "string" && rec.content.trim()) {
        items.push({ kind: "marker", text: `while you were away: ${rec.content.trim()}`, ts });
      }
      continue;
    }

    if (rec.type === "user" && msg) {
      if (typeof msg.content === "string") {
        const text = cleanUserText(msg.content);
        if (text) items.push({ kind: "user", text, ts });
        else {
          const note = taskNotificationSummary(msg.content);
          if (note) items.push({ kind: "marker", text: `task: ${note}`, ts });
        }
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block?.type === "tool_result") {
            const tool = toolsById.get(block.tool_use_id);
            if (tool) {
              tool.result = resultToText(block.content).slice(0, 20_000);
              tool.isError = block.is_error === true;
            }
          } else if (block?.type === "text" && typeof block.text === "string") {
            const text = cleanUserText(block.text);
            if (text) items.push({ kind: "user", text, ts });
            else {
              const note = taskNotificationSummary(block.text);
              if (note) items.push({ kind: "marker", text: `task: ${note}`, ts });
            }
          }
        }
      }
      continue;
    }

    if (rec.type === "assistant" && Array.isArray(msg?.content)) {
      const model = typeof msg.model === "string" ? msg.model : undefined;
      for (const block of msg.content) {
        if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
          items.push({ kind: "assistant", text: block.text.trim(), model, ts });
        } else if (block?.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
          items.push({ kind: "thinking", text: block.thinking.trim(), ts });
        } else if (block?.type === "tool_use" && block.id) {
          const tool: ToolItem = {
            kind: "tool",
            id: block.id,
            name: String(block.name ?? "tool"),
            summary: toolSummary(String(block.name ?? "tool"), block.input),
            input: block.input,
            ts,
          };
          toolsById.set(block.id, tool);
          items.push(tool);
        }
      }
    }
  }
  return items;
}


// ---------------------------------------------------------------------------
// How full the context is. Claude Code stamps a `usage` block on every
// assistant message, and the LAST one describes the window as it stood at that
// turn — which is exactly what carries into the next one.
// ---------------------------------------------------------------------------

export interface ContextUsage {
  /** Tokens that will be re-sent on the next turn (prompt + cache + last output). */
  used: number;
  /** The model's context window — see the inference note in contextUsageFrom. */
  window: number;
  model: string | null;
}

/**
 * Reads the most recent `usage` out of transcript lines, newest first.
 *
 * `used` sums the four parts that make up what the next request carries:
 * fresh input, freshly cached input, cache reads, and the output just
 * produced. Cache reads dominate in a long session and are the whole point —
 * they are the conversation itself, not an optimisation detail.
 *
 * The WINDOW is inferred rather than read: the transcript records the model as
 * "claude-opus-5" whether it runs with the 200k window or the 1M one, and the
 * distinction is invisible there. A session already past 200k is provably on
 * the large window; anything else is assumed standard. Wrong only in one
 * direction (a 1M session under 200k reads as "nearly full" instead of "barely
 * started"), and it corrects itself the moment it crosses.
 */
export function contextUsageFrom(lines: readonly string[]): ContextUsage | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !line.includes('"usage"')) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // a corrupt line is skipped, never fatal (store's rule)
    }
    const message = rec.message as Record<string, unknown> | undefined;
    const usage = message?.usage as Record<string, unknown> | undefined;
    if (!usage) continue;
    const n = (key: string): number => {
      const v = usage[key];
      return typeof v === "number" && Number.isFinite(v) ? v : 0;
    };
    const used =
      n("input_tokens") +
      n("cache_creation_input_tokens") +
      n("cache_read_input_tokens") +
      n("output_tokens");
    if (used <= 0) continue;
    const model = typeof message?.model === "string" ? (message.model as string) : null;
    return { used, window: used > 200_000 ? 1_000_000 : 200_000, model };
  }
  return null;
}
