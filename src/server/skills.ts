// Skill discovery, so the chat composer's "/" menu offers what the agent can
// ACTUALLY run rather than a hard-coded list of the built-ins.
//
// The wrapper shipped with fourteen Claude Code commands typed into a literal.
// An operator with seventy-odd skills of their own typed "/" and saw none of
// them — the menu was not filtering them out, it had never looked.
//
// Two scopes, matching where Claude Code itself reads them from:
//   ~/.claude/skills/<name>/SKILL.md        — yours, everywhere
//   <agent cwd>/.claude/skills/<name>/SKILL.md — this project's
// The project scope is resolved from the AGENT's registered cwd, never from a
// path handed in by the caller: this endpoint answers over a dashboard that
// may be sitting behind a tunnel, and "read any directory you name" is not a
// thing to offer through one.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Skill {
  /** What you type after the slash. */
  name: string;
  /** One line, already trimmed to something a menu row can hold. */
  description: string;
  /** Where it came from, so the menu can group and the operator can tell
   *  a project skill from a global one with the same name. */
  scope: "user" | "project";
}

/** How much of a description a menu row can use before it is noise. */
const DESCRIPTION_LIMIT = 120;

/**
 * Pulls `name` and `description` out of a SKILL.md front matter block.
 *
 * A deliberately small YAML reader rather than a dependency: the front matter
 * this needs is two scalar keys, and the stack is locked. It does handle the
 * one piece of real YAML that shows up here — block scalars (`description: |`
 * and `>`), which several of these skills use and which a naive
 * `split(":")[1]` reads as an empty string.
 */
export function parseSkillFrontMatter(source: string): { name?: string; description?: string } {
  if (!source.startsWith("---")) return {};
  const end = source.indexOf("\n---", 3);
  if (end < 0) return {};
  const body = source.slice(source.indexOf("\n") + 1, end + 1);
  const lines = body.split("\n");
  const out: { name?: string; description?: string } = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = /^([A-Za-z_][\w-]*):(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    if (key !== "name" && key !== "description") continue;
    let value = m[2].trim();

    // Block scalar: the value is the indented lines that follow.
    if (value === "|" || value === ">" || value === "|-" || value === ">-") {
      const folded = value.startsWith(">");
      const collected: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j];
        if (next.trim() === "") {
          collected.push("");
          continue;
        }
        if (!/^\s/.test(next)) break; // dedented — the block ended
        collected.push(next.replace(/^\s+/, ""));
        i = j;
      }
      value = folded ? collected.join(" ") : collected.join("\n");
    } else {
      // Strip matching quotes, if any.
      const quoted = /^"(.*)"$/.exec(value) ?? /^'(.*)'$/.exec(value);
      if (quoted) value = quoted[1];
    }

    value = value.replace(/\s+/g, " ").trim();
    if (key === "name") out.name = value;
    else out.description = value;
  }
  return out;
}

/** Reads one skill directory, or null when it is not one. */
function readSkill(dir: string, scope: Skill["scope"]): Skill | null {
  const file = path.join(dir, "SKILL.md");
  let source: string;
  try {
    source = fs.readFileSync(file, "utf8");
  } catch {
    return null; // no SKILL.md — not a skill, just a directory
  }
  const meta = parseSkillFrontMatter(source);
  // The directory name is the fallback: a skill with a broken front matter is
  // still invokable, and hiding it would be worse than showing it bare.
  const name = (meta.name || path.basename(dir)).trim();
  if (!/^[\w.:-]+$/.test(name)) return null;
  let description = meta.description ?? "";
  if (description.length > DESCRIPTION_LIMIT) {
    description = description.slice(0, DESCRIPTION_LIMIT - 1).trimEnd() + "…";
  }
  return { name, description, scope };
}

function listSkillsIn(root: string, scope: Skill["scope"]): Skill[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return []; // the directory simply does not exist — the normal case
  }
  const found: Skill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const skill = readSkill(path.join(root, entry.name), scope);
    if (skill) found.push(skill);
  }
  return found;
}

export interface DiscoverOptions {
  /** The agent's working directory, for project-scoped skills. */
  cwd?: string | null;
  /** Overridable for tests. */
  homeDir?: string;
}

/**
 * Every skill the agent in `cwd` could invoke, project scope first.
 *
 * A project skill SHADOWS a user skill of the same name — which is what Claude
 * Code does, and what the operator means by putting it there. Listing both
 * would offer two identical rows that do different things.
 */
export function discoverSkills(options: DiscoverOptions = {}): Skill[] {
  const home = options.homeDir ?? os.homedir();
  const project = options.cwd ? listSkillsIn(path.join(options.cwd, ".claude", "skills"), "project") : [];
  const user = listSkillsIn(path.join(home, ".claude", "skills"), "user");

  const byName = new Map<string, Skill>();
  for (const skill of project) byName.set(skill.name, skill);
  for (const skill of user) if (!byName.has(skill.name)) byName.set(skill.name, skill);

  return [...byName.values()].sort((a, b) => {
    // Project skills first (they are the ones you just wrote), then A–Z.
    if (a.scope !== b.scope) return a.scope === "project" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}
