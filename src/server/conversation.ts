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
export type ChatItem = UserItem | AssistantItem | ToolItem;

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

    if (rec.type === "user" && msg) {
      if (typeof msg.content === "string") {
        const text = cleanUserText(msg.content);
        if (text) items.push({ kind: "user", text, ts });
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
          }
        }
      }
      continue;
    }

    if (rec.type === "assistant" && Array.isArray(msg?.content)) {
      for (const block of msg.content) {
        if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
          items.push({ kind: "assistant", text: block.text.trim(), ts });
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
