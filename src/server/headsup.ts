// Claude Code's "Heads up" notes, read from where Claude Code keeps them.
//
// The pane shows a note as one line, a "Learn more" expansion that is cut to a
// few rows ("↓ 12 more") on a short pane, and keys that scroll off the bottom
// with it — so a chat card built from the screen alone lost the detail and
// its buttons (owner, 15/10: "cliquei em learn more e deu pau"). Claude Code's
// built-in "you should know" plugin stores every note it shows, per session:
//
//   ~/.claude/plugins/store/cc-plugin-you-should-know_<hash>.json
//   { sessions: [{ id, view: { kind: "offer" | "explained", line, explanation | text } }] }
//
// `line` is the one-liner on screen; `explanation` (offered) or `text`
// (explained) is the full markdown. The pane still decides WHETHER a note is
// showing; this file only fills in what the screen cut off. Read-only, cached
// on the file's mtime.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface HeadsUpEntry {
  /** The one-liner the pane shows after "✦ Heads up ·". */
  line: string;
  /** The full explanation, as plain lines ("- " for points). */
  detail: string[];
  /** "offer" (collapsed) or "explained" (after Learn more). */
  kind: string;
}

export function headsUpStoreDir(home = os.homedir()): string {
  return path.join(home, ".claude", "plugins", "store");
}

/** Markdown off, one line per line, "* " points made "- ". */
export function headsUpLines(md: string): string[] {
  return md
    .split("\n")
    .map((l) => l.replace(/\*\*|__|`/g, "").replace(/^(\s*)\*\s+/, "$1- ").trimEnd())
    .filter((l) => l.trim())
    .slice(0, 40)
    .map((l) => l.trim().slice(0, 400));
}

let cache: { file: string; mtimeMs: number; entries: HeadsUpEntry[] } | null = null;

/** Every note the store holds a view for. [] when there is no store. */
export function headsUpEntries(dir = headsUpStoreDir()): HeadsUpEntry[] {
  let file: string | undefined;
  let mtimeMs = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith("cc-plugin-you-should-know") || !name.endsWith(".json")) continue;
      const full = path.join(dir, name);
      const m = fs.statSync(full).mtimeMs;
      if (!file || m > mtimeMs) {
        file = full;
        mtimeMs = m;
      }
    }
  } catch {
    return [];
  }
  if (!file) return [];
  if (cache && cache.file === file && cache.mtimeMs === mtimeMs) return cache.entries;
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return cache?.entries ?? []; // mid-write: keep what we had
  }
  const entries: HeadsUpEntry[] = [];
  const sessions = (data as { sessions?: unknown }).sessions;
  for (const s of Array.isArray(sessions) ? sessions : []) {
    const view = (s as { view?: Record<string, unknown> } | null)?.view;
    if (!view || typeof view.line !== "string") continue;
    const md = typeof view.text === "string" ? view.text : typeof view.explanation === "string" ? view.explanation : "";
    entries.push({ line: view.line, detail: headsUpLines(md), kind: String(view.kind ?? "") });
  }
  cache = { file, mtimeMs, entries };
  return entries;
}

const norm = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

/** The stored note whose one-liner is the one on screen, or null. */
export function findHeadsUp(paneText: string, entries: HeadsUpEntry[] = headsUpEntries()): HeadsUpEntry | null {
  const shown = norm(paneText).slice(0, 80);
  if (shown.length < 12) return null;
  return entries.find((e) => {
    const stored = norm(e.line).slice(0, 80);
    return stored.startsWith(shown) || shown.startsWith(stored);
  }) ?? null;
}

/**
 * The keys Claude Code offers in each state — seen live on 11/10 and 12/10 —
 * for when they have scrolled off a short pane.
 */
export function defaultHeadsUpKeys(kind: string): Array<{ key: string; label: string }> {
  if (kind === "offer") {
    return [
      { key: "1", label: "Learn more" },
      { key: "2", label: "Knew this already" },
      { key: "0", label: "Dismiss" },
    ];
  }
  if (kind === "explained") {
    return [
      { key: "1", label: "Understood" },
      { key: "2", label: "Chat in main session" },
      { key: "0", label: "Dismiss" },
    ];
  }
  return [];
}
