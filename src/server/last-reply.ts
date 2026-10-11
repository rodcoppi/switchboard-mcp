// The last thing each agent said, for its card on the rail (design pass,
// owner 11/10: "a última coisa que ele falou" under the agent itself).
//
// Read from the end of the agent's own conversation (its transcript, chosen
// the same way the chat chooses it — sessions.ts), never from its screen.
// Cheap by construction: one stat per agent per sweep, and the tail is only
// read again when the file actually changed (size or mtime). The result is
// written onto the agent record only when it differs, so it rides the usual
// agent_updated event and a quiet board writes nothing.

import fs from "node:fs";
import { parseConversation } from "./conversation.js";
import { findCodexRolloutForCwd, parseCodexRollout } from "./codexlog.js";
import { transcriptFor } from "./sessions.js";
import { resolveAgentType } from "../shared/agent-types.js";
import type { Agent } from "../shared/types.js";
import type { Store } from "./store.js";

/** How much of the file's end is read: plenty for the last reply, never the whole log. */
const TAIL_BYTES = 96 * 1024;
/** What the card shows at most. */
export const LAST_REPLY_MAX = 180;
/** A codex rollout is found by scanning; remember it for this long. */
const CODEX_FIND_TTL_MS = 60_000;

/** Markdown and whitespace off, the first real line(s), cut to the card's length. */
export function plainReply(text: string): string {
  const lines = text
    .replace(/```[\s\S]*?```/g, " ")
    .split("\n")
    .map((l) => l.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/, "").trim())
    .filter(Boolean);
  const flat = lines
    .join(" ")
    .replace(/\*\*|__|`/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > LAST_REPLY_MAX ? `${flat.slice(0, LAST_REPLY_MAX - 1).trimEnd()}…` : flat;
}

/** The last assistant reply in some transcript lines, or null. */
export function lastReplyIn(lines: string[], codex: boolean): { text: string; at: string } | null {
  const items = codex ? parseCodexRollout(lines) : parseConversation(lines);
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind !== "assistant" || !it.text.trim()) continue;
    // A provider error the CLI logged as a reply is not something it said.
    if (/^\s*API Error:/i.test(it.text)) continue;
    const text = plainReply(it.text);
    if (text) return { text, at: it.ts ?? "" };
  }
  return null;
}

function readTail(file: string, size: number): string[] {
  const len = Math.min(size, TAIL_BYTES);
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, buf, 0, len, size - len);
  } finally {
    fs.closeSync(fd);
  }
  const lines = buf.toString("utf8").split("\n");
  if (len < size) lines.shift(); // the first line was cut in half by the tail
  return lines.filter((l) => l.trim());
}

export class LastReplies {
  private readonly cache = new Map<string, { file: string; size: number; mtimeMs: number; reply: { text: string; at: string } | null }>();
  private readonly codexFiles = new Map<string, { file: string | null; at: number }>();

  constructor(private readonly store: Store) {}

  private transcriptOf(agent: Agent): { file: string | null; codex: boolean } {
    if (!agent.cwd) return { file: null, codex: false };
    if (resolveAgentType(agent.agentType) === "codex") {
      const known = this.codexFiles.get(agent.name);
      if (known && Date.now() - known.at < CODEX_FIND_TTL_MS) return { file: known.file, codex: true };
      let file: string | null = null;
      try {
        file = findCodexRolloutForCwd(agent.cwd);
      } catch {
        file = null;
      }
      this.codexFiles.set(agent.name, { file, at: Date.now() });
      return { file, codex: true };
    }
    return { file: transcriptFor(this.store.baseDir, agent, this.store.listAgents()), codex: false };
  }

  /** The agent's last reply now, re-read only when its transcript changed. */
  of(agent: Agent): { text: string; at: string } | null {
    const { file, codex } = this.transcriptOf(agent);
    if (!file) return null;
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      return null;
    }
    const hit = this.cache.get(agent.name);
    if (hit && hit.file === file && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.reply;
    let reply: { text: string; at: string } | null = null;
    try {
      reply = lastReplyIn(readTail(file, st.size), codex);
    } catch {
      reply = hit?.reply ?? null;
    }
    this.cache.set(agent.name, { file, size: st.size, mtimeMs: st.mtimeMs, reply });
    return reply;
  }

  /**
   * One sweep: every agent whose last reply changed gets it on its record.
   * Returns the names that changed (the caller emits agent_updated).
   */
  sweep(): string[] {
    const changed: string[] = [];
    for (const agent of this.store.listAgents()) {
      const reply = this.of(agent);
      if (!reply) continue;
      if (agent.lastReply === reply.text && (agent.lastReplyAt ?? "") === reply.at) continue;
      this.store.updateAgent(agent.name, { lastReply: reply.text, lastReplyAt: reply.at });
      changed.push(agent.name);
    }
    return changed;
  }
}
