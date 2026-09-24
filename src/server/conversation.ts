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
  /**
   * Images the tool handed back — a screenshot, a rendered page, a photo the
   * agent was asked to look at. REFERENCES, never the bytes: these arrive as
   * base64 in the transcript at ~200 KB each and a single conversation here
   * holds hundreds, so inlining them would put 60 MB of data URL into a chat
   * payload. The dashboard fetches each one from the transcript on demand.
   */
  images?: ToolImage[];
  /**
   * Files the agent SENT, via the SendUserFile tool — the same mechanism the
   * Claude app uses to put an attachment in the conversation. Without this the
   * chip read "SendUserFile" and nothing else, and the file it was handing
   * over was invisible.
   */
  files?: SentFile[];
  /** The agent's own one-line note about what it is sending. */
  caption?: string;
}

/** A file the agent deliberately handed to the operator. */
export interface SentFile {
  /** Absolute path on the hub's machine. */
  path: string;
  /** Basename, for the label. */
  name: string;
}

/** Where to find one image inside the transcript, and what it is. */
export interface ToolImage {
  /** The JSONL record's own uuid — stable, and unique per line. */
  uuid: string;
  /** Which image within that record (a tool may return several). */
  index: number;
  mediaType: string;
  /** Decoded size, for the UI to decide whether to lazy-load. */
  bytes: number;
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

/** Media types worth rendering. Anything else is served as a download. */
const RENDERABLE_IMAGE = /^image\/(png|jpeg|jpg|gif|webp|avif|bmp|svg\+xml)$/i;

/**
 * The image blocks inside one tool_result, as references.
 *
 * `source.data` is deliberately not read here beyond its length: the point of
 * this function is to describe the images without carrying them.
 */
export function imagesInResult(content: unknown, uuid: string): ToolImage[] {
  if (!Array.isArray(content) || !uuid) return [];
  const out: ToolImage[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: unknown; source?: unknown };
    if (b.type !== "image") continue;
    const src = b.source as { type?: unknown; media_type?: unknown; data?: unknown } | undefined;
    if (!src || src.type !== "base64" || typeof src.data !== "string") continue;
    const mediaType = typeof src.media_type === "string" ? src.media_type : "image/png";
    if (!RENDERABLE_IMAGE.test(mediaType)) continue;
    out.push({
      uuid,
      index: out.length,
      mediaType,
      // base64 carries 3 bytes per 4 characters, less the padding.
      bytes: Math.max(0, Math.floor((src.data.length * 3) / 4) - (src.data.endsWith("==") ? 2 : src.data.endsWith("=") ? 1 : 0)),
    });
  }
  return out;
}

/**
 * The files a SendUserFile call is handing over, or null for any other tool.
 *
 * Only absolute paths are accepted: the dashboard turns each one into a
 * download link, and a relative path would be resolved against something the
 * agent never meant.
 */
export function sentFilesFrom(
  toolName: string,
  input: unknown,
): { files: SentFile[]; caption?: string } | null {
  if (toolName !== "SendUserFile") return null;
  if (!input || typeof input !== "object") return null;
  const raw = (input as { files?: unknown }).files;
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  const files: SentFile[] = [];
  for (const entry of list) {
    if (typeof entry !== "string" || !entry.startsWith("/")) continue;
    const name = entry.split("/").pop() || entry;
    files.push({ path: entry, name });
  }
  if (!files.length) return null;
  const rawCaption = (input as { caption?: unknown }).caption;
  const caption =
    typeof rawCaption === "string" && rawCaption.trim() ? rawCaption.trim().slice(0, 400) : undefined;
  return { files, caption };
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
              // A screenshot came back with no text at all until now: the tool
              // row said "Read" and showed nothing, because resultToText only
              // ever looked for text blocks.
              const images = imagesInResult(block.content, typeof rec.uuid === "string" ? rec.uuid : "");
              if (images.length) tool.images = images;
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
          const toolName = String(block.name ?? "tool");
          const tool: ToolItem = {
            kind: "tool",
            id: block.id,
            name: toolName,
            summary: toolSummary(toolName, block.input),
            input: block.input,
            ts,
          };
          // SendUserFile is how an agent HANDS a file over — the same
          // mechanism the Claude app renders as an attachment. Pulled apart
          // here so the dashboard can offer the file instead of printing the
          // tool's name and dropping it on the floor.
          const sent = sentFilesFrom(toolName, block.input);
          if (sent) {
            tool.files = sent.files;
            if (sent.caption) tool.caption = sent.caption;
          }
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
  /** Tokens the next request will carry (prompt + cache; output excluded). */
  used: number;
  /** The model's context window — see contextWindowFor. */
  window: number;
  model: string | null;
}

/** The window assumed for a model nobody mapped (tokens). */
export const DEFAULT_CONTEXT_WINDOW = 200_000;
const LONG_CONTEXT_WINDOW = 1_000_000;

/**
 * Model families that run with the 1M window. Ported from the claudinei
 * reference table and checked against the ids this machine's transcripts
 * actually record in message.model: claude-opus-5, claude-opus-5-5,
 * claude-opus-4-6/7/8, claude-fable-5, claude-fable-5-1, claude-sonnet-5,
 * claude-sonnet-4-6, and the explicit "claude-opus-5[1m]" variant.
 *
 * Outside this list the answer is the conservative 200k (Haiku, Opus 4.5 and
 * older): underestimating shows the gauge fuller than it is — never emptier.
 */
const LONG_CONTEXT: RegExp[] = [
  /^(fable|mythos)$/,
  /(fable|mythos)-\d/,
  /^opus$/, /opus[-_ ]?5\b/, /opus[-_ ]?4[-_.]?[678]\b/,
  /^sonnet$/, /sonnet[-_ ]?5\b/, /sonnet[-_ ]?4[-_.]?6\b/,
];

/**
 * A model id's context window. The CLI's "[1m]" suffix is the 1M window
 * switched on explicitly and wins outright; Haiku is checked before the long
 * families because it is current-generation yet 200k.
 */
export function contextWindowFor(model: string | null | undefined): number {
  const m = (model ?? "").trim().toLowerCase();
  if (!m) return DEFAULT_CONTEXT_WINDOW;
  if (m.includes("[1m]")) return LONG_CONTEXT_WINDOW;
  if (m.includes("haiku")) return DEFAULT_CONTEXT_WINDOW;
  return LONG_CONTEXT.some((re) => re.test(m)) ? LONG_CONTEXT_WINDOW : DEFAULT_CONTEXT_WINDOW;
}

/**
 * Reads the most recent `usage` out of transcript lines, newest first.
 *
 * `used` = fresh input + freshly cached input + cache reads — what that
 * request carried, i.e. the whole conversation up to it. Cache reads dominate
 * in a long session and are the whole point. Output tokens are EXCLUDED, to
 * match the Claude CLI's own meter (and the reference implementation): the
 * reply is counted once it comes back as input on the next turn.
 *
 * Sidechain lines (subagent transcripts, isSidechain:true) are skipped: their
 * usage describes the subagent's own window, not this conversation's.
 *
 * The window comes from the model id (contextWindowFor). A session whose use
 * already exceeds that is provably on a bigger window, so it is bumped to 1M
 * rather than shown past 100%.
 *
 * `engine: "codex"` reads a Codex rollout instead (codexContextFrom), so a
 * caller holding either kind of transcript has one entry point.
 */
export function contextUsageFrom(
  lines: readonly string[],
  engine: "claude" | "codex" = "claude",
): ContextUsage | null {
  if (engine === "codex") return codexContextFrom(lines);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !line.includes('"usage"')) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // a corrupt line is skipped, never fatal (store's rule)
    }
    if (rec.isSidechain === true) continue;
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
      n("cache_read_input_tokens");
    if (used <= 0) continue;
    const model = typeof message?.model === "string" ? (message.model as string) : null;
    const byModel = contextWindowFor(model);
    return { used, window: used > byModel ? Math.max(byModel, LONG_CONTEXT_WINDOW) : byModel, model };
  }
  return null;
}

/**
 * The same reading for a Codex rollout. Codex's token_count events say it
 * outright — no table needed (verified on real rollouts, codex-cli 0.154.0):
 *   {type:"event_msg", payload:{type:"token_count", info:{
 *     last_token_usage:{total_tokens, ...}, model_context_window: 258400 }}}
 * `last_token_usage.total_tokens` is the last request's size (the conversation
 * as it stood), and `model_context_window` is the session's ACTIVE window
 * (which can be smaller than the model's published maximum). No window → null:
 * the gauge hides rather than borrowing Claude's numbers. The model is taken
 * from the newest turn_context line when one is in the same batch.
 */
export function codexContextFrom(lines: readonly string[]): ContextUsage | null {
  let found: { used: number; window: number } | null = null;
  let model: string | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    const isCount = !found && line.includes('"token_count"');
    const isTurn = found && line.includes('"turn_context"');
    if (!isCount && !isTurn) continue;
    let rec: { type?: unknown; payload?: Record<string, unknown> };
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const p = rec.payload;
    if (!p || typeof p !== "object") continue;
    if (isCount) {
      if (p.type !== "token_count") continue;
      const info = p.info as Record<string, unknown> | null | undefined;
      const win = info?.model_context_window;
      const last = info?.last_token_usage as Record<string, unknown> | undefined;
      const used = last?.total_tokens;
      if (typeof win !== "number" || !Number.isFinite(win) || win <= 0) continue;
      if (typeof used !== "number" || !Number.isFinite(used) || used <= 0) continue;
      found = { used, window: win };
    } else if (rec.type === "turn_context" && typeof p.model === "string") {
      model = p.model;
      break;
    }
  }
  return found ? { ...found, model } : null;
}
