// Which Claude conversation belongs to which agent, when several agents share
// one folder — an agent and its children (owner, 05/10: "o agente cria um
// filho ... com uma sessao nova do mesmo projeto").
//
// Claude keeps every conversation of a folder side by side in one directory
// (~/.claude/projects/<folder>/<session-id>.jsonl), and the board used to take
// "the newest one" as the agent's. With a child working in its parent's folder
// that answer is wrong half the time: each would show the other's chat, and
// the parent's `claude -c` would resume whichever spoke last.
//
// So a child is launched with a SessionStart hook — passed with --settings,
// for that one session; the operator's own settings are never touched — that
// APPENDS a line to <baseDir>/sessions/<name>.jsonl on startup, resume, /clear
// and compact. Appending (not overwriting) matters: after a /clear the child's
// old conversation must stay claimed, or it would surface in the parent's
// chat. A conversation claimed by any child — even one killed since — is
// never anyone else's; the parent's is the newest that nobody claims.
//
// Verified 05/10 against claude 2.1: --session-id starts a conversation under
// a chosen id, the hook's stdin carries {session_id, transcript_path, cwd,
// source}, and /clear fires it again with a NEW id and source "clear" (the new
// transcript has no link to the old one — nothing else could have told them
// apart).

import fs from "node:fs";
import path from "node:path";
import { projectDirForCwd } from "./conversation.js";
import { AGENT_NAME_RE } from "./store.js";
import type { Agent } from "../shared/types.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function sessionsDir(baseDir: string): string {
  return path.join(baseDir, "sessions");
}

export function sessionLogPath(baseDir: string, name: string): string {
  return path.join(sessionsDir(baseDir), `${name}.jsonl`);
}

/** POSIX single-quote escaping — the hook runs through sh. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The --settings value that makes a session report itself. The name is
 * spelled into the command (it is agent-name shaped, validated) rather than
 * read from the environment, so the log always lands under the agent that
 * was launched. The hook's stdin is one JSON object; newlines are squeezed
 * out so it stays one line of the log. It prints nothing — a SessionStart
 * hook's output would be added to the agent's context.
 */
export function sessionHookSettings(baseDir: string, name: string): string {
  if (!AGENT_NAME_RE.test(name)) throw new Error(`Invalid agent name for a session log: "${name}".`);
  const dir = sessionsDir(baseDir);
  const file = sessionLogPath(baseDir, name);
  const command = `mkdir -p ${shq(dir)} && { tr -d '\\n'; echo; } >> ${shq(file)}`;
  return JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command }] }] } });
}

interface SessionMark {
  sessionId: string;
  cwd: string | null;
}

function readLog(file: string): SessionMark[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const marks: SessionMark[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as { session_id?: unknown; cwd?: unknown };
      if (typeof rec.session_id !== "string" || !UUID_RE.test(rec.session_id)) continue;
      marks.push({ sessionId: rec.session_id, cwd: typeof rec.cwd === "string" ? rec.cwd : null });
    } catch {
      /* a torn line: skip it, never fail on it */
    }
  }
  return marks;
}

/** Every conversation `name` has had, oldest first. */
export function sessionHistory(baseDir: string, name: string): string[] {
  return readLog(sessionLogPath(baseDir, name)).map((m) => m.sessionId);
}

/** Does this agent keep its own conversation (a child, or one pinned to an id)? */
export function isTracked(agent: Agent): boolean {
  return Boolean(agent.parent || agent.sessionId);
}

/** The conversation a tracked agent is in now: what its hook said last, else the id it was launched with. */
export function currentSessionOf(baseDir: string, agent: Agent): string | null {
  const history = sessionHistory(baseDir, agent.name);
  if (history.length) return history[history.length - 1];
  return agent.sessionId && UUID_RE.test(agent.sessionId) ? agent.sessionId : null;
}

const samePlace = (a: string, b: string): boolean => path.resolve(a) === path.resolve(b);

/**
 * Conversations in `agent`'s folder that belong to SOMEBODY ELSE: everything
 * any other session log ever recorded there (children alive or killed), plus
 * the ids other tracked agents were launched with.
 */
export function claimedElsewhere(baseDir: string, agent: Agent, all: readonly Agent[]): Set<string> {
  const claimed = new Set<string>();
  let files: string[] = [];
  try {
    files = fs.readdirSync(sessionsDir(baseDir)).filter((f) => f.endsWith(".jsonl"));
  } catch {
    files = [];
  }
  for (const f of files) {
    if (f === `${agent.name}.jsonl`) continue;
    for (const m of readLog(path.join(sessionsDir(baseDir), f))) {
      if (m.cwd === null || samePlace(m.cwd, agent.cwd)) claimed.add(m.sessionId);
    }
  }
  for (const other of all) {
    if (other.name === agent.name || !other.sessionId || !samePlace(other.cwd, agent.cwd)) continue;
    claimed.add(other.sessionId);
  }
  return claimed;
}

/**
 * The transcript file the board shows (and a wake resumes) for `agent`, or
 * null when it has none yet.
 *
 * A tracked agent has exactly ITS conversation — never "the newest", which
 * before its first message would be the parent's. Everyone else gets the
 * newest conversation in the folder that nobody else claims; with no child
 * around that is the newest one, exactly the old behaviour.
 */
export function transcriptFor(baseDir: string, agent: Agent, all: readonly Agent[]): string | null {
  if (!agent.cwd) return null;
  const dir = projectDirForCwd(agent.cwd);
  if (isTracked(agent)) {
    const own = currentSessionOf(baseDir, agent);
    if (!own) return null;
    const file = path.join(dir, `${own}.jsonl`);
    return fs.existsSync(file) ? file : null;
  }
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return null;
  }
  const claimed = claimedElsewhere(baseDir, agent, all);
  const mine = names
    .filter((f) => !claimed.has(f.slice(0, -".jsonl".length)))
    .map((f) => {
      const full = path.join(dir, f);
      let mtime = 0;
      try {
        mtime = fs.statSync(full).mtimeMs;
      } catch {
        mtime = 0;
      }
      return { full, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return mine.length ? mine[0].full : null;
}

/** Does anyone tracked work in `agent`'s folder (so "newest" is no longer safe for it)? */
export function sharesFolderWithTracked(agent: Agent, all: readonly Agent[]): boolean {
  return all.some((o) => o.name !== agent.name && isTracked(o) && o.cwd && samePlace(o.cwd, agent.cwd));
}

/** Children's session logs follow a rename of their agent. */
export function renameSessionLog(baseDir: string, from: string, to: string): void {
  try {
    fs.renameSync(sessionLogPath(baseDir, from), sessionLogPath(baseDir, to));
  } catch {
    /* no log (not a child, or never started): nothing to move */
  }
}
