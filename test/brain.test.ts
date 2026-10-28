// The group brain (owner, 24/10; reviewed 28/10): the switchboard side of the
// acceptance tests — D (isolation), E (performance) and F (units). A, B and C
// are measured by ai-panorama on the real network.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store, type StoreLogger } from "../src/server/store.js";
import { BrainIndex, recencyBoost, type Chunk } from "../src/server/brain/index.js";
import { entities, fold, looksSecret, redact, snippet, stem, terms } from "../src/server/brain/text.js";
import { Brain } from "../src/server/brain/brain.js";
import { markdownSections, neverIndexed, parseMemory } from "../src/server/brain/sources.js";

const quiet: StoreLogger = { info: () => {}, warn: () => {} };
const DAY = 86_400_000;

describe("text (F)", () => {
  it("folds case and accents, and stems so the forms of a word meet", () => {
    expect(fold("Publicação no AR")).toBe("publicacao no ar");
    const forms = ["publicou", "publicado", "publicação", "publicações"].map((w) => terms(w)[0]);
    expect(new Set(forms).size).toBe(1);
    expect(stem("s60")).toBe("s60");
  });

  it("keeps identifiers whole beside their parts, and finds them as entities", () => {
    expect(terms("rodada-2026-10-20")).toContain("rodada-2026-10-20");
    expect(terms("rodada-2026-10-20")).toContain("rodada");
    expect(entities("O S60 está em redes/data/publicacoes.json")).toEqual(
      expect.arrayContaining(["s60", "redes/data/publicacoes.json", "publicacoes.json"]),
    );
    expect(entities("uma frase sem identificador")).toEqual([]);
    expect(entities("em 2026, 10 vezes")).toEqual([]); // a bare number names nothing
  });

  it("drops the stopwords of both languages", () => {
    expect(terms("o que é isso para a gente")).toEqual(["gente"]);
    expect(terms("the state of it")).toEqual(["state"]);
  });

  it("redacts every secret shape before anything is stored (B, units)", () => {
    const token = "a".repeat(64);
    const raw = [
      `token do agente ${token}`,
      "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuv",
      "password: hunter2hunter2",
      "github ghp_abcdefghijklmnopqrstuvwxyz0123",
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.abcdefghijklmno",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----",
      "Set-Cookie: sid=abc123def456",
      "AKIAABCDEFGHIJKLMNOP",
    ].join("\n");
    const clean = redact(raw);
    expect(clean).not.toContain(token);
    expect(clean).not.toContain("sk-abcdefghijklmnopqrstuv");
    expect(clean).not.toContain("hunter2hunter2");
    expect(clean).not.toContain("ghp_");
    expect(clean).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(clean).not.toContain("MIIabc");
    expect(clean).not.toContain("abc123def456");
    expect(clean).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(looksSecret(clean)).toBe(false);
    expect(looksSecret("nada secreto aqui")).toBe(false);
  });

  it("quotes the original around the match, never a rewrite", () => {
    const long = `${"intro ".repeat(200)}o S60 foi publicado ontem${" fim".repeat(200)}`;
    const s = snippet(long, ["s60", "public"], 200);
    expect(s).toContain("S60 foi publicado");
    expect(s.length).toBeLessThanOrEqual(202);
  });
});

const chunk = (over: Partial<Chunk> & { id: string }): Chunk => ({
  source: "memories",
  groups: ["agency"],
  agent: "hq",
  title: "",
  text: "",
  date: new Date().toISOString(),
  path: "/x",
  anchor: "1",
  ...over,
});

describe("the index (F)", () => {
  it("ranks by BM25 with the title counting more, and only within the scope", () => {
    const ix = new BrainIndex();
    ix.add(chunk({ id: "b", title: "Outra coisa", text: "um texto que fala de domínio de passagem" }));
    ix.add(chunk({ id: "a", title: "Domínio do site", text: "decidimos comprar o .com.br" }));
    ix.add(chunk({ id: "c", groups: ["studio"], title: "Domínio do studio", text: "domínio do outro grupo" }));
    const hits = ix.search("o domínio", new Set(["agency"]));
    expect(hits.map((h) => h.title)).toEqual(["Domínio do site", "Outra coisa"]);
    expect(ix.search("domínio", new Set(["studio"])).map((h) => h.title)).toEqual(["Domínio do studio"]);
  });

  it("matches identifiers by equality, even with no other word in common", () => {
    const ix = new BrainIndex();
    ix.add(chunk({ id: "a", title: "Rodada", text: "a rodada-2026-10-20 fechou com 12 leads" }));
    ix.add(chunk({ id: "b", title: "Outra rodada", text: "a rodada-2026-10-13 fechou com 9 leads" }));
    expect(ix.search("rodada-2026-10-20", new Set(["agency"]))[0].title).toBe("Rodada");
  });

  it("weighs the newer above the older, capped, and never pushes the old below its own score", () => {
    const now = Date.now();
    expect(recencyBoost(now, now)).toBeCloseTo(1.5);
    expect(recencyBoost(now - 30 * DAY, now)).toBeCloseTo(1.25);
    expect(recencyBoost(now - 3650 * DAY, now)).toBeGreaterThanOrEqual(1);
  });

  it("unasked (strict), only clear matches: a distinctive identifier or most of the words", () => {
    const ix = new BrainIndex();
    ix.add(chunk({ id: "a", title: "Capa", text: "a capa do vídeo ficou amarela" }));
    ix.add(chunk({ id: "b", title: "S60", text: "o S60 saiu em 2026" }));
    for (let i = 0; i < 30; i++) ix.add(chunk({ id: `y${i}`, title: `nota ${i}`, text: `registro de 2026 número ${i}` }));
    const scope = new Set(["agency"]);
    expect(ix.search("vamos refazer a capa do roteiro novo da semana", scope).map((h) => h.title)).toContain("Capa");
    expect(ix.search("vamos refazer a capa do roteiro novo da semana", scope, { strict: true })).toEqual([]);
    expect(ix.search("e o S60, como ficou?", scope, { strict: true }).map((h) => h.title)).toEqual(["S60"]);
    expect(ix.search("o que temos pra 2026 inteiro", scope, { strict: true })).toEqual([]); // a bare year names nothing
  });

  it("flags two hits that contradict each other about the same thing, newer first (C, units)", () => {
    const ix = new BrainIndex();
    const now = Date.now();
    ix.add(chunk({ id: "old", source: "memories", title: "S60 pendente", text: "o S60 está pendente de aprovação", date: new Date(now - 2 * DAY).toISOString() }));
    ix.add(chunk({ id: "new", source: "messages", title: "vide-editor → chefe", text: "o S60 foi publicado hoje no YouTube", date: new Date(now).toISOString() }));
    const hits = ix.search("o S60 já foi publicado?", new Set(["agency"]));
    expect(hits[0].date).toBe(new Date(now).toISOString()); // the newer first, whatever its source weight
    const old = hits.find((h) => h.title === "S60 pendente")!;
    expect(old.conflict?.note).toMatch(/pending vs published about s60/);
  });

  it("asked, one stray common word among known ones is not a match", () => {
    const ix = new BrainIndex();
    ix.add(chunk({ id: "a", title: "Agenda", text: "a agenda de quinta com os convidados" }));
    ix.add(chunk({ id: "b", title: "Plano anual", text: "o preço do plano anual subiu" }));
    expect(ix.search("qual o preço do plano anual de quinta", new Set(["agency"])).map((h) => h.title)).toEqual(["Plano anual"]);
  });

  it("forgets what is removed", () => {
    const ix = new BrainIndex();
    ix.add(chunk({ id: "a", title: "Domínio", text: "domínio comprado" }));
    ix.remove("a");
    expect(ix.size).toBe(0);
    expect(ix.search("domínio", new Set(["agency"]))).toEqual([]);
  });

  it("answers in well under a second over 50 thousand chunks (E)", () => {
    const ix = new BrainIndex();
    const words = ["publicado", "pendente", "roteiro", "cliente", "vídeo", "agenda", "proposta", "domínio", "linkedin", "carrossel", "capa", "voz"];
    for (let i = 0; i < 50_000; i++) {
      const w = (k: number) => words[(i * 7 + k * 13) % words.length];
      ix.add(chunk({ id: `c${i}`, title: `S${i % 400} ${w(1)}`, text: `${w(2)} ${w(3)} ${w(4)} nota ${i} sobre ${w(5)} e ${w(6)}`, date: new Date(Date.now() - (i % 300) * DAY).toISOString() }));
    }
    const t0 = performance.now();
    const hits = ix.search("o S60 foi publicado ou está pendente?", new Set(["agency"]));
    const ms = performance.now() - t0;
    expect(hits.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(1000);
  }, 60_000);
});

describe("sources (F)", () => {
  it("reads a memory's frontmatter", () => {
    const m = parseMemory('---\nname: dominio\ndescription: "Decisão do domínio"\nmetadata:\n  modified: 2026-10-20T10:00:00.000Z\n---\n\nComprar o .com.br.\n');
    expect(m).toMatchObject({ name: "dominio", description: "Decisão do domínio", modified: "2026-10-20T10:00:00.000Z" });
    expect(m.body.trim()).toBe("Comprar o .com.br.");
  });

  it("splits markdown by its ## sections", () => {
    const s = markdownSections("# Título\nintro\n## Um\na\n## Dois\nb\n");
    expect(s.map((x) => [x.heading, x.line])).toEqual([["", 1], ["Um", 3], ["Dois", 5]]);
  });

  it("never reads credentials, env files, lockfiles or archived memory", () => {
    for (const p of ["/p/state/auth/x.json", "/p/tokens.json", "/p/.env", "/p/.env.local", "/h/.claude/.credentials.json", "/p/memory/arquivo/a.md", "/p/package-lock.json"]) {
      expect(neverIndexed(p), p).toBe(true);
    }
    expect(neverIndexed("/p/planos/plano.md")).toBe(false);
  });
});

// --- the brain, end to end, on a temp board ------------------------------------

let dir: string;
let store: Store;
let projects: string;
const projectDir = (cwd: string) => path.join(projects, cwd.replace(/[^a-zA-Z0-9]/g, "-"));

function write(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}
function memory(cwd: string, name: string, description: string, body: string): void {
  write(path.join(projectDir(cwd), "memory", `${name}.md`), `---\nname: ${name}\ndescription: "${description}"\n---\n\n${body}\n`);
}
function transcript(cwd: string, id: string, lines: object[]): string {
  const file = path.join(projectDir(cwd), `${id}.jsonl`);
  write(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-brain-"));
  projects = path.join(dir, "claude-projects");
  store = new Store(path.join(dir, "data"), quiet);
  for (const g of ["agency", "agency/acme", "studio"]) store.createGroup(g);
  const reg = (name: string, group: string, extra: Record<string, unknown> = {}) => {
    const cwd = path.join(dir, "work", name);
    fs.mkdirSync(cwd, { recursive: true });
    store.registerAgent({ name, tmuxSession: `sb-${name}`, cwd, group, ...extra });
    return cwd;
  };
  reg("hq", "agency");
  reg("editor", "agency");
  reg("acme-social", "agency/acme");
  reg("studio-dev", "studio");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const brainOf = () => new Brain({ store, baseDir: path.join(dir, "data"), intervalMs: 0, projectDir });

describe("who sees what (D)", () => {
  it("an agency agent sees its group and its clients; a client only itself; another group nothing", async () => {
    memory(store.getAgent("hq")!.cwd, "s60", "S60 publicado em 23/10", "O S60 foi publicado no YouTube em 23/10.");
    memory(store.getAgent("acme-social")!.cwd, "acme-plano", "Plano zorbatrix da Acme", "A Acme fechou o plano zorbatrix.");
    memory(store.getAgent("studio-dev")!.cwd, "studio-site", "Site do studio quixotron", "O site quixotron do studio subiu.");
    const brain = brainOf();
    await brain.setGroup("agency", { enabled: true });
    await brain.setGroup("agency/acme", { enabled: true });
    await brain.setGroup("studio", { enabled: true });

    expect(brain.search("hq", "zorbatrix").results.map((r) => r.agent)).toEqual(["acme-social"]); // the agency sees its client
    expect(brain.search("acme-social", "S60 publicado").results).toEqual([]); // the client never sees the agency
    expect(brain.search("studio-dev", "S60 publicado").results).toEqual([]); // another group sees nothing
    expect(brain.search("studio-dev", "zorbatrix").results).toEqual([]);
    expect(brain.search("hq", "quixotron").results).toEqual([]);
    // a line between groups lends no knowledge
    store.linkGroups("agency", "studio");
    expect(brain.search("hq", "quixotron").results).toEqual([]);
    // the operator and the assistant see every group that is on
    expect(brain.search("operator", "quixotron").results).toHaveLength(1);
    store.registerAgent({ name: "faz-tudo", tmuxSession: "sb-faz-tudo", cwd: path.join(dir, "work", "faz") });
    store.updateAgent("faz-tudo", { everywhere: true });
    expect(brain.search("faz-tudo", "zorbatrix").results).toHaveLength(1);
  });

  it("a group that is off is not read, and turning it off forgets it", async () => {
    memory(store.getAgent("hq")!.cwd, "s60", "S60 publicado", "O S60 foi publicado.");
    const brain = brainOf();
    expect(brain.search("hq", "S60").results).toEqual([]);
    await brain.setGroup("agency", { enabled: true });
    expect(brain.search("hq", "S60").results).toHaveLength(1);
    await brain.setGroup("agency", { enabled: false });
    expect(brain.index.size).toBe(0);
  });
});

describe("the connectors, on a temp board", () => {
  it("memories: read once, re-read only when changed, dropped when deleted", async () => {
    const cwd = store.getAgent("hq")!.cwd;
    memory(cwd, "dominio", "Decisão do domínio", "Comprar o .com.br.");
    const brain = brainOf();
    await brain.setGroup("agency", { enabled: true });
    expect(brain.search("hq", "domínio").results[0].title).toBe("dominio — Decisão do domínio");
    await brain.cycle();
    expect(brain.status().connectors.memories.added).toBe(0); // nothing changed: nothing re-read
    fs.rmSync(path.join(projectDir(cwd), "memory", "dominio.md"));
    await brain.cycle();
    expect(brain.search("hq", "domínio").results).toEqual([]);
  });

  it("project files: sections, the deeper agent owns them, other groups' folders are never walked", async () => {
    const hq = store.getAgent("hq")!.cwd;
    write(path.join(hq, "planos", "plano.md"), "# Plano\n## Domínio\nComprar o .com.br até sexta.\n## Capa\nRefazer a capa.\n");
    write(path.join(hq, "node_modules", "x", "README.md"), "domínio node_modules");
    write(path.join(hq, "data", "raw", "reddit.json"), '{"t": "domínio raspado da web"}');
    write(path.join(hq, "dump.json"), JSON.stringify({ d: "domínio ".repeat(40_000) }));
    write(path.join(hq, "tokens.json"), '{"domínio": "secret"}');
    // A studio agent working INSIDE the agency's folder: never walked into.
    const inside = path.join(hq, "studio-inside");
    store.registerAgent({ name: "studio-in", tmuxSession: "sb-studio-in", cwd: inside, group: "studio" });
    write(path.join(inside, "notas.md"), "o domínio do studio é segredo dele");
    const brain = brainOf();
    await brain.setGroup("agency", { enabled: true });
    const hits = brain.search("hq", "domínio").results;
    expect(hits.map((h) => h.title)).toEqual(["Plano › Domínio"]);
    expect(hits[0].path).toBe(path.join(hq, "planos", "plano.md"));
  });

  it("messages: each belongs to both sides' groups, and a new one is found at once", async () => {
    store.appendMessage({ from: "hq", to: "editor", body: "o vídeo S61 está agendado para sábado" });
    const brain = brainOf();
    await brain.setGroup("agency", { enabled: true });
    expect(brain.search("editor", "S61 agendado").results[0].title).toBe("hq → editor");
    const m = store.appendMessage({ from: "editor", to: "hq", body: "S61 publicado agora" });
    brain.noteMessage(m);
    expect(brain.search("hq", "S61").results.map((r) => r.title)).toContain("editor → hq");
  });

  it("sessions: one chunk per exchange, typed words only, read incrementally", async () => {
    const cwd = store.getAgent("editor")!.cwd;
    const at = (n: number) => new Date(Date.now() - (10 - n) * 60_000).toISOString();
    const file = transcript(cwd, "11111111-1111-4111-8111-111111111111", [
      { type: "user", uuid: "u1", timestamp: at(1), message: { role: "user", content: "decide a fonte da capa do zumbarte" } },
      { type: "assistant", timestamp: at(2), message: { role: "assistant", content: [{ type: "text", text: "Fica a fonte Inter Black, decidido." }] } },
      { type: "user", timestamp: at(3), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "segredo-do-tool zumbarte" }] } },
      { type: "user", uuid: "u2", timestamp: at(4), message: { role: "user", content: "[switchboard] 1 new message from hq — call check_messages" } },
    ]);
    const brain = brainOf();
    await brain.setGroup("agency", { enabled: true });
    const hits = brain.search("hq", "zumbarte").results;
    expect(hits).toHaveLength(1);
    expect(hits[0].snippet).toContain("Inter Black");
    expect(hits[0].snippet).not.toContain("segredo-do-tool");
    fs.appendFileSync(
      file,
      [
        { type: "user", uuid: "u3", timestamp: at(5), message: { role: "user", content: "e a cor do zumbarte?" } },
        { type: "assistant", timestamp: at(6), message: { role: "assistant", content: [{ type: "text", text: "Amarelo #FFD400." }] } },
      ].map((l) => JSON.stringify(l)).join("\n") + "\n",
    );
    await brain.cycle();
    expect(brain.search("hq", "zumbarte").results).toHaveLength(2);
    expect(brain.status().connectors.sessions.added).toBe(1); // only the new exchange was read
  });

  it("git: one chunk per commit, incrementally", async () => {
    const cwd = store.getAgent("hq")!.cwd;
    const git = (...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    write(path.join(cwd, "a.txt"), "a");
    git("add", "a.txt");
    git("commit", "-q", "-m", "feat: o domínio virou .com.br", "-m", "decisão de 20/10");
    const brain = brainOf();
    await brain.setGroup("agency", { sources: { projectFiles: false }, enabled: true });
    expect(brain.search("hq", "domínio").results[0]).toMatchObject({ source: "git", title: "feat: o domínio virou .com.br" });
    write(path.join(cwd, "b.txt"), "b");
    git("add", "b.txt");
    git("commit", "-q", "-m", "fix: capa nova do zumbarte");
    await brain.cycle();
    expect(brain.status().connectors.git.added).toBe(1);
  });

  it("comes back from disk after a restart, owner-only", async () => {
    memory(store.getAgent("hq")!.cwd, "dominio", "Decisão do domínio", "Comprar o .com.br.");
    const brain = brainOf();
    await brain.setGroup("agency", { enabled: true });
    const file = path.join(dir, "data", "brain", "chunks.jsonl");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const again = brainOf();
    await again.ready();
    expect(again.search("hq", "domínio").results).toHaveLength(1);
    expect(again.status().connectors.memories.added).toBe(0); // nothing re-read
  });

  it("nothing secret-shaped reaches the index (B)", async () => {
    const hq = store.getAgent("hq")!.cwd;
    write(path.join(hq, "notas.md"), `# Notas\nA chave é sk-abcdefghijklmnopqrstuv e o token ${"b".repeat(64)}.\npassword = hunter2hunter2\n`);
    const brain = brainOf();
    await brain.setGroup("agency", { enabled: true });
    expect(brain.index.size).toBeGreaterThan(0);
    for (const c of brain.index.chunks()) expect(looksSecret(`${c.title}\n${c.text}`), c.id).toBe(false);
  });

  it("never stalls the hub while it reads a big transcript (E)", async () => {
    const cwd = store.getAgent("editor")!.cwd;
    const lines: object[] = [];
    for (let i = 0; i < 40_000; i++) {
      lines.push({ type: "user", uuid: `u${i}`, timestamp: new Date().toISOString(), message: { role: "user", content: `pergunta ${i} sobre o roteiro ${"x".repeat(200)}` } });
      lines.push({ type: "assistant", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: `resposta ${i} ${"y".repeat(400)}` }] } });
    }
    transcript(cwd, "22222222-2222-4222-8222-222222222222", lines);
    const brain = brainOf();
    let worst = 0;
    let last = performance.now();
    const probe = setInterval(() => {
      const now = performance.now();
      worst = Math.max(worst, now - last - 5);
      last = now;
    }, 5);
    await brain.setGroup("agency", { enabled: true, sources: { memories: false, projectFiles: false, git: false, messages: false } });
    clearInterval(probe);
    expect(brain.index.size).toBeGreaterThan(30_000);
    expect(worst).toBeLessThan(250);
  }, 120_000);
});

describe("what the agent is handed", () => {
  it("the prompt hook: the best hits for the prompt, or nothing", async () => {
    memory(store.getAgent("editor")!.cwd, "s60", "S60 publicado em 23/10", "O S60 foi publicado no YouTube em 23/10 pelo editor.");
    const brain = brainOf();
    await brain.setGroup("agency", { enabled: true });
    const ctx = brain.promptContext("hq", "o Rodrigo já decidiu publicar o S60?");
    expect(ctx).toMatch(/^\[switchboard brain\]/);
    expect(ctx).toContain("S60 publicado em 23/10");
    expect(brain.promptContext("hq", "/compact")).toBe("");
    expect(brain.promptContext("hq", "[switchboard] 1 new message from editor")).toBe("");
    expect(brain.promptContext("hq", "ok")).toBe("");
    expect(brain.promptContext("hq", "uma pergunta sem nada a ver com nada disso")).toBe("");
    expect(brain.promptContext("studio-dev", "o Rodrigo já decidiu publicar o S60?")).toBe("");
  });

  it("the session briefing: what others changed since the agent was last here", async () => {
    memory(store.getAgent("editor")!.cwd, "s60", "S60 publicado em 23/10", "O S60 foi publicado.");
    memory(store.getAgent("hq")!.cwd, "agenda", "Agenda do hq", "A agenda do hq.");
    const brain = brainOf();
    await brain.setGroup("agency", { enabled: true });
    const brief = brain.briefing("hq");
    expect(brief).toContain("S60 publicado em 23/10");
    expect(brief).not.toContain("Agenda do hq"); // its own work it already knows
    expect(brief.length).toBeLessThanOrEqual(1500);
  });
});

describe("the hook in the launch argv", () => {
  it("adds the prompt and session hooks, merging into a --settings already there", async () => {
    const { withBrainHooks, brainHookCommand } = await import("../src/server/brain/hook.js");
    const plain = withBrainHooks(["--dangerously-skip-permissions"], 4577, "HOOK");
    expect(plain.slice(0, 2)).toEqual(["--dangerously-skip-permissions", "--settings"]);
    const s = JSON.parse(plain[2]);
    expect(s.hooks.UserPromptSubmit[0].hooks[0]).toMatchObject({ command: "HOOK", timeout: 3 });
    expect(s.hooks.SessionStart[0].hooks[0].command).toBe("HOOK");
    // A child's session log already in --settings: one --settings, both hooks.
    const child = withBrainHooks(["--session-id", "x", "--settings", JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "LOG" }] }] } })], 4577, "HOOK");
    expect(child.filter((a) => a === "--settings")).toHaveLength(1);
    const merged = JSON.parse(child[child.indexOf("--settings") + 1]);
    expect(merged.hooks.SessionStart.map((e: { hooks: Array<{ command: string }> }) => e.hooks[0].command)).toEqual(["LOG", "HOOK"]);
    // Idempotent, and a settings FILE is left alone.
    expect(withBrainHooks(plain, 4577, "HOOK")).toEqual(plain);
    expect(withBrainHooks(["--settings", "/x/settings.json"], 4577, "HOOK")).toEqual(["--settings", "/x/settings.json"]);
    expect(brainHookCommand(4577, "/usr/bin/node", "/r/bin/brain-hook.mjs")).toBe("'/usr/bin/node' '/r/bin/brain-hook.mjs' 4577");
  });
});
