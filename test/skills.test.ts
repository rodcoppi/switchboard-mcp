// The composer's "/" menu offers the agent's OWN skills, not a literal.
//
// The wrapper shipped with fourteen Claude Code commands typed into an object.
// An operator with seventy-odd skills of their own typed "/" and saw none of
// them — nothing in the dashboard had ever looked for them (03/09).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverSkills, parseSkillFrontMatter } from "../src/server/skills.js";
import { startHub, type Hub } from "../src/server/hub.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-skills-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Writes <root>/.claude/skills/<name>/SKILL.md with the given front matter. */
function writeSkill(root: string, name: string, frontMatter: string): void {
  const skillDir = path.join(root, ".claude", "skills", name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), `---\n${frontMatter}\n---\n\n# ${name}\n`);
}

describe("reading a SKILL.md front matter", () => {
  it("reads the plain one-line form", () => {
    const meta = parseSkillFrontMatter("---\nname: antislop\ndescription: Strip AI tells\n---\n\n# body");
    expect(meta.name).toBe("antislop");
    expect(meta.description).toBe("Strip AI tells");
  });

  it("reads a block scalar, which a naive split on ':' reads as empty", () => {
    // Several real skills use `description: |`. Getting this wrong does not
    // hide the skill — it shows it with a blank description, which looks like
    // the skill is broken rather than the reader.
    const meta = parseSkillFrontMatter(
      "---\nname: codex\nversion: 1.0.0\ndescription: |\n  OpenAI Codex CLI wrapper.\n  Three modes.\n---\n\n# body",
    );
    expect(meta.name).toBe("codex");
    expect(meta.description).toBe("OpenAI Codex CLI wrapper. Three modes.");
  });

  it("reads the folded form and strips quotes", () => {
    expect(parseSkillFrontMatter("---\ndescription: >\n  one\n  two\n---\n").description).toBe("one two");
    expect(parseSkillFrontMatter('---\nname: "quoted"\n---\n').name).toBe("quoted");
    expect(parseSkillFrontMatter("---\nname: 'single'\n---\n").name).toBe("single");
  });

  it("returns nothing rather than guessing when there is no front matter", () => {
    expect(parseSkillFrontMatter("# just a heading\n")).toEqual({});
    expect(parseSkillFrontMatter("")).toEqual({});
    expect(parseSkillFrontMatter("---\nunterminated: yes\n")).toEqual({});
  });

  it("ignores keys it was not asked about", () => {
    const meta = parseSkillFrontMatter("---\nname: x\npreamble-tier: 3\nallowed-tools: Bash\n---\n");
    expect(meta.name).toBe("x");
    expect(meta.description).toBeUndefined();
  });
});

describe("discovering what an agent can run", () => {
  it("finds user skills, and survives a home with none", () => {
    expect(discoverSkills({ homeDir: dir, cwd: null })).toEqual([]);
    writeSkill(dir, "antislop", "name: antislop\ndescription: Strip AI tells");
    const found = discoverSkills({ homeDir: dir, cwd: null });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ name: "antislop", scope: "user" });
  });

  it("puts the project's own skills first", () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-proj-"));
    try {
      writeSkill(dir, "zebra", "name: zebra\ndescription: a user skill");
      writeSkill(project, "alpha", "name: alpha\ndescription: a project skill");
      const found = discoverSkills({ homeDir: dir, cwd: project });
      expect(found.map((s) => s.name)).toEqual(["alpha", "zebra"]);
      expect(found[0].scope).toBe("project");
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it("lets a project skill SHADOW a user skill of the same name", () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-proj-"));
    try {
      writeSkill(dir, "deploy", "name: deploy\ndescription: the global one");
      writeSkill(project, "deploy", "name: deploy\ndescription: the project one");
      const found = discoverSkills({ homeDir: dir, cwd: project });
      // Two identical rows that run different things would be worse than
      // either — the agent runs the project one, so that is what is offered.
      expect(found).toHaveLength(1);
      expect(found[0].description).toBe("the project one");
      expect(found[0].scope).toBe("project");
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it("skips directories that are not skills, without falling over", () => {
    fs.mkdirSync(path.join(dir, ".claude", "skills", "not-a-skill"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".claude", "skills", "loose-file.md"), "hello");
    writeSkill(dir, "real", "name: real\ndescription: yes");
    const found = discoverSkills({ homeDir: dir, cwd: null });
    expect(found.map((s) => s.name)).toEqual(["real"]);
  });

  it("still lists a skill whose front matter is broken", () => {
    // A skill with unreadable front matter is STILL invokable by directory
    // name; hiding it would be a worse lie than showing it bare.
    const skillDir = path.join(dir, ".claude", "skills", "busted");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "no front matter here\n");
    const found = discoverSkills({ homeDir: dir, cwd: null });
    expect(found).toHaveLength(1);
    expect(found[0].name).toBe("busted");
    expect(found[0].description).toBe("");
  });

  it("trims a description long enough to wreck a menu row", () => {
    writeSkill(dir, "chatty", `name: chatty\ndescription: ${"x".repeat(400)}`);
    const found = discoverSkills({ homeDir: dir, cwd: null });
    expect(found[0].description.length).toBeLessThanOrEqual(120);
    expect(found[0].description.endsWith("…")).toBe(true);
  });

  it("refuses a name that could not be typed after a slash", () => {
    const skillDir = path.join(dir, ".claude", "skills", "weird");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: has spaces and /slashes\n---\n");
    expect(discoverSkills({ homeDir: dir, cwd: null })).toEqual([]);
  });
});

describe("the skills endpoint", () => {
  let hub: Hub;

  afterEach(async () => {
    await hub?.close();
  });

  it("404s for an agent it does not know", async () => {
    hub = await startHub({ baseDir: dir, port: 0, quiet: true, onMessage: () => "queued_offline" });
    const res = await fetch(`http://127.0.0.1:${hub.port}/api/agents/nobody/skills`);
    expect(res.status).toBe(404);
  });

  it("answers with the skills in the agent's own project", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-proj-"));
    try {
      writeSkill(project, "deploy-thing", "name: deploy-thing\ndescription: ships it");
      hub = await startHub({ baseDir: dir, port: 0, quiet: true, onMessage: () => "queued_offline" });
      const base = `http://127.0.0.1:${hub.port}`;
      await fetch(`${base}/api/agents/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "worker", cwd: project, tmuxSession: "sb-worker" }),
      });
      const res = await fetch(`${base}/api/agents/worker/skills`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; skills: { name: string; scope: string }[] };
      expect(body.ok).toBe(true);
      expect(body.skills.some((s) => s.name === "deploy-thing" && s.scope === "project")).toBe(true);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });
});
