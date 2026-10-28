// The group brain's connectors: one per source, each reading only what is new
// since its last run, stamping what it reads with a date, READ-ONLY on
// everything it touches.
//
//   memories      ~/.claude/projects/<slug(cwd)>/memory/*.md      1 file = 1 chunk
//   messages      the hub's own store                              1 message = 1 chunk
//   projectFiles  each agent's folder: .md (by "## "), .txt, .json  by mtime + size
//   sessions      the agent's Claude Code transcripts              1 exchange = 1 chunk
//   git           the commits of each agent's repository           1 commit = 1 chunk
//
// Nothing here may stall the hub: every loop calls `pace()`, which hands the
// event loop back every few milliseconds, so an agent's tool call is never
// queued behind a scan (the hub's rule: every MCP tool answers in < 1 s).

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cleanUserText, projectDirForCwd } from "../conversation.js";
import { resolveGroup, type Store } from "../store.js";
import type { Agent } from "../../shared/types.js";
import type { BrainIndex, BrainSource, Chunk } from "./index.js";
import { redact } from "./text.js";

const execFileAsync = promisify(execFile);

/** Hands the event loop back once `budgetMs` of work has gone by. */
export function makePacer(budgetMs = 8): () => Promise<void> {
  let last = performance.now();
  return async () => {
    if (performance.now() - last < budgetMs) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
    last = performance.now();
  };
}

/** What the connectors remember between runs (persisted as state.json). */
export interface BrainState {
  /** memories + projectFiles: what each file looked like when read, and the chunks it gave. */
  files: Record<string, { mtimeMs: number; size: number; ids: string[] }>;
  /** sessions: how far each transcript was read, and the exchange still open at its end. */
  sessions: Record<string, { offset: number; open?: OpenExchange }>;
  /** git: the newest commit read per repository. */
  git: Record<string, { head: string }>;
}

interface OpenExchange {
  id: string;
  date: string;
  user: string;
  assistant: string;
}

export function emptyState(): BrainState {
  return { files: {}, sessions: {}, git: {} };
}

export interface ScanContext {
  store: Store;
  index: BrainIndex;
  state: BrainState;
  /** The agents whose knowledge is indexed (enabled groups only). */
  agents: Agent[];
  /** Whether `source` is on for `group`. */
  sourceOn: (group: string, source: BrainSource) => boolean;
  /** Whether a group's brain is on. */
  groupOn: (group: string) => boolean;
  pace: () => Promise<void>;
  /** For tests: where Claude Code keeps projects (default ~/.claude/projects). */
  projectDir?: (cwd: string) => string;
}

export interface ScanResult {
  added: number;
  removed: number;
}

// --- What never enters, whatever the config says --------------------------------

const NEVER_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", ".cache", "coverage", "venv", ".venv",
  "__pycache__", "tool-results", "backups", "arquivo", "tmp", "temp", ".turbo", "vendor", "target",
  // Scraped or downloaded material is other people's text, not the group's
  // knowledge — and what the prompt hook would hand an agent unasked.
  "raw", "scraped", "downloads",
]);
const NEVER_PATH = [
  /(^|\/)state\/auth(\/|$)/,
  /(^|\/)tokens?\.json$/,
  /(^|\/)\.env(\.|$)/,
  /(^|\/)\.credentials\.json$/,
  /(^|\/)memory-backup-[^/]*(\/|$)/,
  /(^|\/)memory\/arquivo(\/|$)/,
  /(^|\/)(package-lock|yarn\.lock|pnpm-lock|composer\.lock)/,
  /\.min\.(js|json)$/,
  /(^|\/)\.switchboard\/(remote|agents)\.json$/,
  /(^|\/)\.codex\/auth\.json$/,
  /(^|\/)\.config\/gcloud(\/|$)/,
];
export function neverIndexed(file: string): boolean {
  return NEVER_PATH.some((re) => re.test(file));
}

const MAX_CHUNK = 6000;
const PIECE = 4000;

/** A long text in line-aligned pieces of about PIECE characters. */
function pieces(text: string): Array<{ text: string; line: number }> {
  if (text.length <= MAX_CHUNK) return [{ text, line: 1 }];
  const out: Array<{ text: string; line: number }> = [];
  let buf: string[] = [];
  let size = 0;
  let start = 1;
  text.split("\n").forEach((l, i) => {
    if (size + l.length > PIECE && buf.length) {
      out.push({ text: buf.join("\n"), line: start });
      buf = [];
      size = 0;
      start = i + 1;
    }
    buf.push(l.length > PIECE ? l.slice(0, PIECE) : l);
    size += l.length + 1;
  });
  if (buf.length) out.push({ text: buf.join("\n"), line: start });
  return out;
}

function owner(agents: Agent[], file: string): Agent | undefined {
  let best: Agent | undefined;
  for (const a of agents) {
    if (!a.cwd) continue;
    const rel = path.relative(a.cwd, file);
    if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
    if (!best || a.cwd.length > best.cwd.length) best = a;
  }
  return best;
}

function setFileChunks(ctx: ScanContext, file: string, mtimeMs: number, size: number, chunks: Chunk[]): ScanResult {
  const before = ctx.state.files[file]?.ids ?? [];
  const now = new Set(chunks.map((c) => c.id));
  let removed = 0;
  for (const id of before) if (!now.has(id) && ctx.index.remove(id)) removed++;
  for (const c of chunks) ctx.index.add(c);
  ctx.state.files[file] = { mtimeMs, size, ids: [...now] };
  return { added: chunks.length, removed };
}

function dropFile(ctx: ScanContext, file: string): number {
  let removed = 0;
  for (const id of ctx.state.files[file]?.ids ?? []) if (ctx.index.remove(id)) removed++;
  delete ctx.state.files[file];
  return removed;
}

// --- memories ---------------------------------------------------------------

/** name / description / metadata.modified out of a memory file's frontmatter. */
export function parseMemory(raw: string): { name: string; description: string; modified?: string; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  const head = m ? m[1] : "";
  const body = m ? raw.slice(m[0].length) : raw;
  const field = (k: string) => {
    const f = new RegExp(`^\\s*${k}:\\s*(.*)$`, "m").exec(head);
    return f ? f[1].trim().replace(/^["']|["']$/g, "") : "";
  };
  return { name: field("name"), description: field("description"), modified: field("modified") || undefined, body };
}

export async function scanMemories(ctx: ScanContext): Promise<ScanResult> {
  const res: ScanResult = { added: 0, removed: 0 };
  const projectDir = ctx.projectDir ?? projectDirForCwd;
  const seen = new Set<string>();
  const dirs = new Map<string, Agent>();
  for (const a of ctx.agents) {
    if (!a.cwd || !ctx.sourceOn(resolveGroup(a.group), "memories")) continue;
    const dir = path.join(projectDir(a.cwd), "memory");
    if (!dirs.has(dir)) dirs.set(dir, a);
  }
  for (const [dir, agent] of dirs) {
    let names: string[] = [];
    try {
      names = await fs.promises.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      await ctx.pace();
      if (!name.endsWith(".md") || name === "MEMORY.md") continue;
      const file = path.join(dir, name);
      if (neverIndexed(file)) continue;
      seen.add(file);
      let st: fs.Stats;
      try {
        st = await fs.promises.stat(file);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      const known = ctx.state.files[file];
      if (known && known.mtimeMs === st.mtimeMs && known.size === st.size) continue;
      const raw = await fs.promises.readFile(file, "utf8").catch(() => "");
      const mem = parseMemory(raw);
      const modified = mem.modified && !Number.isNaN(Date.parse(mem.modified)) ? new Date(mem.modified).toISOString() : st.mtime.toISOString();
      const chunk: Chunk = {
        id: `memories|${file}`,
        source: "memories",
        groups: [resolveGroup(agent.group)],
        agent: agent.name,
        title: redact([mem.name || name.replace(/\.md$/, ""), mem.description].filter(Boolean).join(" — ")),
        text: redact(mem.body.trim()).slice(0, MAX_CHUNK * 2),
        date: modified,
        path: file,
        anchor: "1",
      };
      const r = setFileChunks(ctx, file, st.mtimeMs, st.size, [chunk]);
      res.added += r.added;
      res.removed += r.removed;
    }
  }
  // Files that are gone (or whose agent left an enabled group).
  for (const file of Object.keys(ctx.state.files)) {
    if (!file.includes(`${path.sep}memory${path.sep}`) || seen.has(file)) continue;
    if (!ctx.state.files[file].ids.some((id) => id.startsWith("memories|"))) continue;
    res.removed += dropFile(ctx, file);
  }
  return res;
}

// --- projectFiles -------------------------------------------------------------

const PROJECT_EXT = /\.(md|txt|json)$/i;
/**
 * Past these sizes a file is a dump, not notes: a fetched changelog, a radar
 * of feeds, an export (a dry run on 28/10 found 1.9 MB of JSON among them).
 */
const MAX_TEXT_BYTES = 512 * 1024;
const MAX_JSON_BYTES = 256 * 1024;
const MAX_FILES_PER_ROOT = 4000;
const MAX_DEPTH = 8;

/** A markdown file's "## " sections, each with its heading and first line number. */
export function markdownSections(text: string): Array<{ heading: string; text: string; line: number }> {
  const lines = text.split("\n");
  const out: Array<{ heading: string; text: string; line: number }> = [];
  let cur = { heading: "", text: [] as string[], line: 1 };
  lines.forEach((l, i) => {
    if (/^##\s+/.test(l) && cur.text.some((x) => x.trim())) {
      out.push({ heading: cur.heading, text: cur.text.join("\n"), line: cur.line });
      cur = { heading: l.replace(/^##\s+/, "").trim(), text: [l], line: i + 1 };
    } else {
      if (/^##\s+/.test(l)) cur.heading = l.replace(/^##\s+/, "").trim();
      cur.text.push(l);
    }
  });
  if (cur.text.some((x) => x.trim())) out.push({ heading: cur.heading, text: cur.text.join("\n"), line: cur.line });
  return out;
}

function fileChunks(file: string, raw: string, agent: Agent, date: string): Chunk[] {
  const base = path.basename(file);
  const group = resolveGroup(agent.group);
  const out: Chunk[] = [];
  const add = (title: string, text: string, line: number) => {
    for (const p of pieces(text)) {
      const anchor = String(line + p.line - 1);
      out.push({
        id: `projectFiles|${file}|${anchor}`,
        source: "projectFiles",
        groups: [group],
        agent: agent.name,
        title: redact(title),
        text: redact(p.text),
        date,
        path: file,
        anchor,
      });
    }
  };
  if (/\.md$/i.test(file)) {
    const h1 = /^#\s+(.+)$/m.exec(raw)?.[1]?.trim();
    for (const s of markdownSections(raw)) add([h1 || base, s.heading].filter(Boolean).join(" › "), s.text, s.line);
  } else {
    add(base, raw, 1);
  }
  return out;
}

export async function scanProjectFiles(ctx: ScanContext): Promise<ScanResult> {
  const res: ScanResult = { added: 0, removed: 0 };
  const seen = new Set<string>();
  // Roots: each agent's folder, once; one inside another of the SAME group is
  // covered by the outer walk (and its files go to the deeper agent).
  const byGroup = new Map<string, Agent[]>();
  for (const a of ctx.agents) {
    const g = resolveGroup(a.group);
    if (!a.cwd || !ctx.sourceOn(g, "projectFiles")) continue;
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g)!.push(a);
  }
  // Folders of agents in OTHER groups are never walked into, even when they
  // sit inside one of these (a client's folder under the agency's).
  const allCwds = ctx.store.listAgents().filter((a) => a.cwd);
  for (const [group, agents] of byGroup) {
    const roots = [...new Set(agents.map((a) => path.normalize(a.cwd)))].filter(
      (r, _, all) => !all.some((o) => o !== r && !path.relative(o, r).startsWith("..") && !path.isAbsolute(path.relative(o, r))),
    );
    const fenced = new Set(
      allCwds.filter((a) => resolveGroup(a.group) !== group).map((a) => path.normalize(a.cwd)),
    );
    for (const root of roots) {
      let count = 0;
      const walk = async (dir: string, depth: number): Promise<void> => {
        if (depth > MAX_DEPTH || count >= MAX_FILES_PER_ROOT) return;
        let entries: fs.Dirent[] = [];
        try {
          entries = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          await ctx.pace();
          if (count >= MAX_FILES_PER_ROOT) return;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) {
            if (e.name.startsWith(".") || NEVER_DIRS.has(e.name) || fenced.has(full)) continue;
            await walk(full, depth + 1);
            continue;
          }
          if (!e.isFile() || !PROJECT_EXT.test(e.name) || neverIndexed(full)) continue;
          count++;
          seen.add(full);
          let st: fs.Stats;
          try {
            st = await fs.promises.stat(full);
          } catch {
            continue;
          }
          if (st.size > (/\.json$/i.test(e.name) ? MAX_JSON_BYTES : MAX_TEXT_BYTES)) continue;
          const known = ctx.state.files[full];
          if (known && known.mtimeMs === st.mtimeMs && known.size === st.size) continue;
          const agent = owner(agents, full);
          if (!agent) continue;
          const raw = await fs.promises.readFile(full, "utf8").catch(() => "");
          const r = setFileChunks(ctx, full, st.mtimeMs, st.size, fileChunks(full, raw, agent, st.mtime.toISOString()));
          res.added += r.added;
          res.removed += r.removed;
        }
      };
      await walk(root, 0);
    }
  }
  for (const file of Object.keys(ctx.state.files)) {
    if (seen.has(file)) continue;
    if (!ctx.state.files[file].ids.some((id) => id.startsWith("projectFiles|"))) continue;
    res.removed += dropFile(ctx, file);
  }
  return res;
}

// --- messages -----------------------------------------------------------------

export async function scanMessages(ctx: ScanContext): Promise<ScanResult> {
  const res: ScanResult = { added: 0, removed: 0 };
  const broadcasts = new Set<string>();
  for (const m of ctx.store.listMessages()) {
    await ctx.pace();
    if (m.broadcastId) {
      if (broadcasts.has(m.broadcastId)) continue;
      broadcasts.add(m.broadcastId);
    }
    const id = `messages|${m.broadcastId ?? m.id}`;
    if (ctx.index.has(id)) continue;
    // Both sides were in the conversation: it belongs to each one's group.
    const groups = new Set<string>();
    for (const name of [m.from, m.to]) {
      const a = ctx.store.getAgent(name);
      if (a) groups.add(resolveGroup(a.group));
    }
    const on = [...groups].filter((g) => ctx.groupOn(g) && ctx.sourceOn(g, "messages"));
    if (!on.length) continue;
    ctx.index.add({
      id,
      source: "messages",
      groups: on,
      agent: m.from,
      title: `${m.from} → ${m.broadcastId ? "all" : m.to}`,
      text: redact(m.body),
      date: m.createdAt,
      path: "messages.jsonl",
      anchor: m.id,
    });
    res.added++;
  }
  return res;
}

// --- sessions -----------------------------------------------------------------

/** How far back a transcript is read the first time (the rest of a 500 MB log is old). */
export const SESSION_TAIL_BYTES = 64 * 1024 * 1024;
const SESSION_MAX_AGE_DAYS = 120;
const READ_PIECE = 4 * 1024 * 1024;

/** The typed words of a user record, or "" when it is not the operator typing. */
function typedText(rec: Record<string, unknown>): string {
  if (rec.isMeta || rec.isSidechain) return "";
  const msg = rec.message as { content?: unknown } | undefined;
  if (rec.type === "attachment") {
    const att = rec.attachment as { type?: string; prompt?: unknown } | undefined;
    return att?.type === "queued_command" && typeof att.prompt === "string" ? cleanUserText(att.prompt) : "";
  }
  if (rec.type !== "user" || !msg) return "";
  let text = "";
  if (typeof msg.content === "string") text = msg.content;
  else if (Array.isArray(msg.content)) {
    if (msg.content.some((b) => b && typeof b === "object" && (b as { type?: string }).type === "tool_result")) return "";
    text = msg.content.map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? String((b as { text?: unknown }).text ?? "") : "")).join("\n");
  }
  const clean = cleanUserText(text);
  // The hub's knocks are not the operator talking.
  if (/^\[switchboard\]/.test(clean)) return "";
  return clean;
}

function assistantText(rec: Record<string, unknown>): string {
  if (rec.type !== "assistant" || rec.isSidechain) return "";
  const msg = rec.message as { content?: unknown } | undefined;
  if (!Array.isArray(msg?.content)) return "";
  return msg!.content
    .map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? String((b as { text?: unknown }).text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}

function exchangeChunk(ex: OpenExchange, file: string, agent: Agent): Chunk {
  const user = ex.user.slice(0, 2000);
  const assistant = ex.assistant.length > 6000 ? `…${ex.assistant.slice(-6000)}` : ex.assistant;
  return {
    id: ex.id,
    source: "sessions",
    groups: [resolveGroup(agent.group)],
    agent: agent.name,
    title: redact(user.split("\n")[0].slice(0, 140)),
    text: redact(`${user}\n\n${assistant}`.trim()),
    date: ex.date,
    path: file,
    anchor: ex.id.slice(ex.id.lastIndexOf("|") + 1),
  };
}

export async function scanSessions(ctx: ScanContext): Promise<ScanResult> {
  const res: ScanResult = { added: 0, removed: 0 };
  const projectDir = ctx.projectDir ?? projectDirForCwd;
  const dirs = new Map<string, Agent>();
  for (const a of ctx.agents) {
    if (!a.cwd || !ctx.sourceOn(resolveGroup(a.group), "sessions")) continue;
    const dir = projectDir(a.cwd);
    if (!dirs.has(dir)) dirs.set(dir, a);
  }
  const cutoff = Date.now() - SESSION_MAX_AGE_DAYS * 86_400_000;
  for (const [dir, agent] of dirs) {
    let names: string[] = [];
    try {
      names = (await fs.promises.readdir(dir)).filter((n) => n.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const name of names) {
      const file = path.join(dir, name);
      let st: fs.Stats;
      try {
        st = await fs.promises.stat(file);
      } catch {
        continue;
      }
      if (st.mtimeMs < cutoff) continue;
      let entry: BrainState["sessions"][string] | undefined = ctx.state.sessions[file];
      if (entry && st.size < entry.offset) entry = undefined; // rewritten: start over
      let offset = entry?.offset ?? Math.max(0, st.size - SESSION_TAIL_BYTES);
      let skipPartial = !entry && offset > 0;
      if (offset >= st.size) continue;
      let open: OpenExchange | undefined = entry?.open;
      let carry = "";
      const fd = await fs.promises.open(file, "r");
      try {
        while (offset < st.size) {
          const len = Math.min(READ_PIECE, st.size - offset);
          const buf = Buffer.alloc(len);
          await fd.read(buf, 0, len, offset);
          offset += len;
          let text = carry + buf.toString("utf8");
          if (skipPartial) {
            const nl = text.indexOf("\n");
            text = nl === -1 ? "" : text.slice(nl + 1);
            skipPartial = false;
          }
          const last = text.lastIndexOf("\n");
          carry = last === -1 ? text : text.slice(last + 1);
          const complete = last === -1 ? "" : text.slice(0, last);
          for (const line of complete.split("\n")) {
            await ctx.pace();
            if (!line.trim()) continue;
            let rec: Record<string, unknown>;
            try {
              rec = JSON.parse(line);
            } catch {
              continue;
            }
            const ts = typeof rec.timestamp === "string" ? rec.timestamp : new Date(st.mtimeMs).toISOString();
            if (rec.isCompactSummary && rec.type === "user") {
              const msg = rec.message as { content?: unknown } | undefined;
              const body = typeof msg?.content === "string" ? msg.content : "";
              if (body.trim()) {
                const uuid = typeof rec.uuid === "string" ? rec.uuid : `${offset}`;
                ctx.index.add(exchangeChunk({ id: `sessions|${file}|${uuid}`, date: ts, user: "Conversation summary (compaction)", assistant: body }, file, agent));
                res.added++;
              }
              continue;
            }
            const typed = typedText(rec);
            if (typed) {
              if (open && open.assistant.trim()) {
                ctx.index.add(exchangeChunk(open, file, agent));
                res.added++;
              }
              const uuid = typeof rec.uuid === "string" ? rec.uuid : `${offset}`;
              open = { id: `sessions|${file}|${uuid}`, date: ts, user: typed, assistant: "" };
              continue;
            }
            const said = assistantText(rec);
            if (said && open) open.assistant = `${open.assistant}\n${said}`.slice(-12000);
          }
        }
      } finally {
        await fd.close();
      }
      // The exchange still open is indexed as it stands, and kept to grow.
      if (open && open.assistant.trim()) ctx.index.add(exchangeChunk(open, file, agent));
      // Only whole lines count as read: a half-written last line is read next time.
      ctx.state.sessions[file] = { offset: offset - Buffer.byteLength(carry, "utf8"), ...(open ? { open } : {}) };
    }
  }
  return res;
}

// --- git ------------------------------------------------------------------------

const GIT_MAX = 300;

export async function scanGit(ctx: ScanContext): Promise<ScanResult> {
  const res: ScanResult = { added: 0, removed: 0 };
  const roots = new Map<string, Agent>();
  for (const a of ctx.agents) {
    if (!a.cwd || !ctx.sourceOn(resolveGroup(a.group), "git")) continue;
    try {
      const { stdout } = await execFileAsync("git", ["-C", a.cwd, "rev-parse", "--show-toplevel"], { timeout: 5000 });
      const root = stdout.trim();
      if (root && !roots.has(root)) roots.set(root, a);
    } catch {
      /* not a repository */
    }
    await ctx.pace();
  }
  for (const [root, agent] of roots) {
    let head = "";
    try {
      head = (await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"], { timeout: 5000 })).stdout.trim();
    } catch {
      continue; // a repository with no commit yet
    }
    const known = ctx.state.git[root]?.head;
    if (known === head) continue;
    const range = known ? [`${known}..HEAD`] : [];
    let out = "";
    try {
      out = (
        await execFileAsync(
          "git",
          ["-C", root, "log", "--no-merges", `-n`, String(GIT_MAX), "--format=%H%x1f%aI%x1f%s%x1f%b%x1e", ...range],
          { timeout: 15000, maxBuffer: 32 * 1024 * 1024 },
        )
      ).stdout;
    } catch {
      // The known head is gone (a rewritten history): read the latest again.
      try {
        out = (
          await execFileAsync("git", ["-C", root, "log", "--no-merges", "-n", String(GIT_MAX), "--format=%H%x1f%aI%x1f%s%x1f%b%x1e"], {
            timeout: 15000,
            maxBuffer: 32 * 1024 * 1024,
          })
        ).stdout;
        for (const id of ctx.index.idsOf("git", `git|${root}|`)) if (ctx.index.remove(id)) res.removed++;
      } catch {
        continue;
      }
    }
    for (const rec of out.split("\x1e")) {
      await ctx.pace();
      const [hash, date, subject, body] = rec.replace(/^\n/, "").split("\x1f");
      if (!hash || !subject) continue;
      ctx.index.add({
        id: `git|${root}|${hash}`,
        source: "git",
        groups: [resolveGroup(agent.group)],
        agent: agent.name,
        title: redact(subject.trim()),
        text: redact(`${subject.trim()}\n\n${(body ?? "").trim()}`.trim()),
        date: date && !Number.isNaN(Date.parse(date)) ? new Date(date).toISOString() : new Date().toISOString(),
        path: root,
        anchor: hash.slice(0, 12),
      });
      res.added++;
    }
    ctx.state.git[root] = { head };
  }
  return res;
}
