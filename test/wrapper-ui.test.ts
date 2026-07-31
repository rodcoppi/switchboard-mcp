// Pure helpers embedded in the dashboard: keep the wrapper's local-file and
// WhatsApp-copy contracts covered without introducing a frontend build step.

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const html = fs.readFileSync(path.join(process.cwd(), "public", "index.html"), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
const source = ts.createSourceFile("dashboard.js", script, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);

function embeddedFunction<T extends (...args: any[]) => any>(name: string): T {
  let found: ts.FunctionDeclaration | undefined;
  source.forEachChild((node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
  });
  if (!found) throw new Error(`Embedded function ${name} not found`);
  const code = script.slice(found.getStart(source), found.getEnd());
  return new Function(`return (${code})`)() as T;
}

/**
 * Like embeddedFunction, but evaluates a GROUP of embedded functions in one
 * scope and returns the named one — for page functions that call each other
 * (toWhatsAppText → unwrapForWhatsApp).
 */
function embeddedFunctionWith<T extends (...args: any[]) => any>(name: string, helpers: string[]): T {
  const wanted = new Set([name, ...helpers]);
  const codes: string[] = [];
  source.forEachChild((node) => {
    if (ts.isFunctionDeclaration(node) && node.name && wanted.has(node.name.text)) {
      codes.push(script.slice(node.getStart(source), node.getEnd()));
    }
  });
  if (codes.length !== wanted.size) throw new Error(`Expected ${wanted.size} embedded functions, found ${codes.length}`);
  return new Function(`${codes.join("\n")}\nreturn ${name};`)() as T;
}

describe("wrapper local markdown links", () => {
  const localFileTarget = embeddedFunction<(href: string) => { path: string; line: number | null } | null>("localFileTarget");

  it("strips the :line suffix instead of navigating localhost to it", () => {
    expect(localFileTarget("/home/rodcoppi/projects/ClaudeMaster/public/index.html:48")).toEqual({
      path: "/home/rodcoppi/projects/ClaudeMaster/public/index.html",
      line: 48,
    });
  });

  it("accepts file URIs and keeps normal web links alone", () => {
    expect(localFileTarget("file:///tmp/report.md#L17")).toEqual({ path: "/tmp/report.md", line: 17 });
    expect(localFileTarget("https://example.com/docs:48")).toBeNull();
    expect(localFileTarget("/docs/getting-started")).toBeNull();
  });
});

describe("wrapper slash command routing", () => {
  const isSlashCommand = embeddedFunction<(text: string) => boolean>("isSlashCommand");

  it("switches real slash commands to the terminal", () => {
    expect(isSlashCommand("/review")).toBe(true);
    expect(isSlashCommand("/model opus")).toBe(true);
  });

  it("keeps pasted absolute paths in chat", () => {
    expect(isSlashCommand("/home/rodcoppi/Downloads/report.md")).toBe(false);
    expect(isSlashCommand("/mnt/c/Users/User/Downloads/report.md")).toBe(false);
  });
});

describe("WhatsApp copy formatting", () => {
  const toWhatsAppText = embeddedFunctionWith<(text: string) => string>("toWhatsAppText", ["unwrapForWhatsApp"]);

  it("maps markdown emphasis, headings, tasks and links", () => {
    expect(toWhatsAppText("# Release\n\n**Done** and *reviewed*\n- [ ] Send\n[notes](https://example.com/n)")).toBe(
      "*Release*\n\n*Done* and _reviewed_\n☐ Send\nnotes — https://example.com/n",
    );
  });

  it("does not rewrite formatting punctuation inside code", () => {
    expect(toWhatsAppText("Use `**literal**` then **bold**")).toBe("Use `**literal**` then *bold*");
  });

  // The owner's WhatsApp complaint: agents draft messages hard-wrapped at ~75
  // columns (often inside a fence), and the pasted result broke on every line.
  const wrapped =
    "O sistema está pronto e rodando na máquina de vocês. Hoje ele está fazendo a\n" +
    "primeira varredura completa dos 118 clientes: ele passa em cada um, consulta\n" +
    "os processos e registra tudo que existe hoje. Essa passada é só o retrato.\n" +
    "\n" +
    "Uma coisa importante sobre o tempo: a verificação completa leva algumas horas\n" +
    "e isso é de propósito, então o sistema respeita o ritmo dos tribunais deles.";

  it("joins hard-wrapped paragraph lines (paragraph breaks kept)", () => {
    const out = toWhatsAppText(wrapped);
    expect(out.split("\n\n")).toHaveLength(2);
    for (const para of out.split("\n\n")) expect(para).not.toContain("\n");
    expect(out).toContain("fazendo a primeira varredura");
  });

  it("unwraps a PROSE fence and drops the fence markers", () => {
    const out = toWhatsAppText("```\n" + wrapped + "\n```");
    expect(out).not.toContain("```");
    expect(out).toContain("fazendo a primeira varredura");
    expect(out.split("\n\n")).toHaveLength(2);
  });

  it("keeps a REAL code fence byte-for-byte", () => {
    const code = "```js\nconst x = compute(1);\nif (x > 2) { emit(x); }\nreturn x + settle(x, 3);\n```";
    expect(toWhatsAppText(code)).toBe(code);
  });

  it("leaves intentional short lines alone", () => {
    const short = "linha um\nlinha dois\nlinha três";
    expect(toWhatsAppText(short)).toBe(short);
  });

  it("keeps bullets on their own lines and folds a bullet's wrapped continuation", () => {
    const out = toWhatsAppText(
      "Este parágrafo introdutório está embrulhado em duas linhas longas para o teste\n" +
        "de sessenta caracteres disparar a junção automática das linhas do bloco.\n" +
        "- primeiro item da lista com texto comprido o bastante para dobrar de linha\n" +
        "  e esta continuação indentada pertence ao item acima\n" +
        "- segundo item",
    );
    const lines = out.split("\n");
    expect(lines[0]).toContain("disparar a junção");
    expect(lines[1]).toBe("• primeiro item da lista com texto comprido o bastante para dobrar de linha e esta continuação indentada pertence ao item acima");
    expect(lines[2]).toBe("• segundo item");
  });
});

describe("wrapper reopen loading state", () => {
  // Behavior, not units: the rail re-renders on every SSE event, so a reopen
  // in flight must be re-derivable from state (state.reopening), never from a
  // label mutated on the live button node — the old version blinked back to
  // "reopen" mid-launch and looked dead. Source-level contract assertions.
  function embeddedFunctionSource(name: string): string {
    let found: ts.FunctionDeclaration | undefined;
    source.forEachChild((node) => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
    });
    if (!found) throw new Error(`Embedded function ${name} not found`);
    return script.slice(found.getStart(source), found.getEnd());
  }

  it("reopenAgent tracks the in-flight launch in state and re-renders on settle", () => {
    const src = embeddedFunctionSource("reopenAgent");
    expect(src).toContain("state.reopening.add(agent.name)");
    expect(src).toContain("state.reopening.delete(agent.name)");
    // The finally must re-render (the clicked node may be orphaned), not
    // poke the possibly-dead node back to its idle label.
    expect(src).toContain("renderAgents()");
    expect(src).not.toContain('btn.textContent = "reopen"');
    // Double-click guard.
    expect(src).toContain("if (state.reopening.has(agent.name)) return;");
  });

  it("the card renderer derives the busy button from state.reopening", () => {
    const src = embeddedFunctionSource("buildAgentCard");
    expect(src).toContain("state.reopening.has(agent.name)");
    expect(src).toContain('"reopen-btn busy"');
    expect(src).toContain('"reopening…"');
  });

  it("the busy button has a real spinner, not just a label swap", () => {
    expect(html).toContain(".reopen-btn.busy::before");
    expect(html).toMatch(/@keyframes reopen-spin/);
  });

  it("the busy button stays visible after the pointer leaves the card", () => {
    // .agent-actions is a hover-revealed cluster (opacity 0 at rest); an
    // in-flight relaunch must pin it visible or the loading state vanishes
    // the moment the user moves the mouse.
    expect(html).toContain(".agent-actions:has(.reopen-btn.busy)");
  });
});

describe("dictation waveform", () => {
  // The dictation block is event-handler code, not an extractable function —
  // these are source-level contract locks. The waveform must ride the SAME
  // analyser as the silence watchdog, show only while recording, and be
  // fully torn down by stopLevel (rAF cancelled, canvas hidden).
  it("the composer has the waveform canvas, hidden at rest", () => {
    expect(html).toContain('<canvas class="chat-wave" id="chat-wave" hidden');
    expect(html).toContain(".chat-wave[hidden] { display: none; }");
  });

  it("recording shows the canvas and stopping tears the drawing down", () => {
    expect(script).toContain("waveEl.hidden = false");
    expect(script).toContain("requestAnimationFrame(drawWave)");
    expect(script).toContain("cancelAnimationFrame(waveRaf)");
    expect(script).toContain("waveEl.hidden = true");
  });

  it("the watchdog interval survives independently of the rAF drawer", () => {
    // rAF pauses in background tabs; the silence watchdog must not (a tab
    // switch mid-recording would otherwise fake "pure silence").
    expect(script).toContain('micBtn.textContent = peak > 0.02 ? "⏺" : "◌"');
  });
});
