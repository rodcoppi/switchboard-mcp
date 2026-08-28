// Pure helpers embedded in the dashboard: keep the wrapper's local-file and
// WhatsApp-copy contracts covered without introducing a frontend build step.

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const html = fs.readFileSync(path.join(process.cwd(), "public", "index.html"), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
const source = ts.createSourceFile("dashboard.js", script, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
/** The page's CSS — the keyframes live here, not in the script block. */
const styles = (html.match(/<style>[\s\S]*?<\/style>/g) || []).join("\n");

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
  // Only the CLI's OWN commands live on the terminal screen — their output
  // never reaches the JSONL the chat mirrors, so the chat would show nothing.
  // A skill is an ordinary turn and belongs in the chat; flipping the view to
  // run one was throwing the operator out of where he was working (22/08).
  // Closes over the page-level CLI_BUILTIN_COMMANDS const — rebuild the whole
  // scope, the way the BARE_URL_RE block does.
  const list = script.match(/const CLI_BUILTIN_COMMANDS = new Set\(\[[\s\S]*?\]\);/)?.[0];
  if (!list) throw new Error("CLI_BUILTIN_COMMANDS not found in the page");
  const fns: string[] = [];
  source.forEachChild((node) => {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name &&
      ["runsOnTerminalScreen", "slashCommandName"].includes(node.name.text)
    ) {
      fns.push(script.slice(node.getStart(source), node.getEnd()));
    }
  });
  if (fns.length !== 2) throw new Error(`expected 2 functions, found ${fns.length}`);
  const runsOnTerminalScreen = new Function(
    `${list}\n${fns.join("\n")}\nreturn runsOnTerminalScreen;`,
  )() as (text: string) => boolean;

  it("the CLI's own commands go to the terminal", () => {
    expect(runsOnTerminalScreen("/model opus")).toBe(true);
    expect(runsOnTerminalScreen("/clear")).toBe(true);
    expect(runsOnTerminalScreen("/context")).toBe(true);
    expect(runsOnTerminalScreen("/MCP")).toBe(true); // case does not matter
  });

  it("skills stay in the chat, where their answer lands", () => {
    expect(runsOnTerminalScreen("/dash-redes")).toBe(false);
    expect(runsOnTerminalScreen("/codex review")).toBe(false);
    expect(runsOnTerminalScreen("/watch:watch https://x")).toBe(false); // plugin skill
    expect(runsOnTerminalScreen("/pre-orcamento cliente x")).toBe(false);
  });

  it("keeps pasted absolute paths in chat", () => {
    expect(runsOnTerminalScreen("/home/rodcoppi/Downloads/report.md")).toBe(false);
    expect(runsOnTerminalScreen("/mnt/c/Users/User/Downloads/report.md")).toBe(false);
    expect(runsOnTerminalScreen("olha /model isso")).toBe(false); // not at the start
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

  it("an open kebab menu outranks the neighbouring rail groups", () => {
    // The hover lift (transform) makes the card a stacking context, and the
    // next .rail-group paints later in DOM order — without a rank on the
    // card itself, the dropdown rendered BEHIND the following group.
    expect(html).toContain(".agent-card.menu-open { z-index: 45; }");
  });

  it("the rail rebuild spares an open menu AND an active rename input", () => {
    // The activity poll re-renders every ~2.5s; a rebuild mid-typing
    // destroyed the rename/nickname input ("it kicks me out").
    expect(html).toContain('querySelector(".agent-menu:not([hidden]), .agent-rename-input")');
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

describe("wrapper nudge peek", () => {
  // The hub's typed knock ("[switchboard] N new message(s) from: …") renders
  // as the SYSTEM's turn with a peek at the real message(s) from the store.
  const parseNudgeLine = embeddedFunction<(text: string) => { count: number; senders: string[] } | null>("parseNudgeLine");
  const nudgeQuoteCandidates = embeddedFunction<
    (n: { count: number; senders: string[] }, agent: string, ts: string, pool: any[]) => any[]
  >("nudgeQuoteCandidates");

  it("recognizes the dispatcher's two nudge shapes and nothing else", () => {
    expect(parseNudgeLine("[switchboard] 1 new message(s) from: ai-panorama. Use the check_messages tool to read them.")).toEqual({
      count: 1,
      senders: ["ai-panorama"],
    });
    expect(parseNudgeLine("[switchboard] 3 new message(s) from: alpha, beta. Use the check_messages tool to read them.")).toEqual({
      count: 3,
      senders: ["alpha", "beta"],
    });
    expect(parseNudgeLine("[switchboard] Manual nudge from operator. Use the check_messages tool to check your queue.")).toEqual({
      count: 0,
      senders: [],
    });
    expect(parseNudgeLine("bora almoçar?")).toBeNull();
    expect(parseNudgeLine("")).toBeNull();
  });

  it("finds the messages behind the nudge: right sender, right recipient, before the knock", () => {
    const pool = [
      { from: "ai-panorama", to: "rodcoppi", body: "old", createdAt: "2026-08-01T11:00:00Z" },
      { from: "ai-panorama", to: "rodcoppi", body: "the one", createdAt: "2026-08-01T12:14:00Z" },
      { from: "ai-panorama", to: "OTHER", body: "wrong recipient", createdAt: "2026-08-01T12:14:00Z" },
      { from: "someone-else", to: "rodcoppi", body: "wrong sender", createdAt: "2026-08-01T12:14:00Z" },
      { from: "ai-panorama", to: "rodcoppi", body: "after the knock", createdAt: "2026-08-01T12:30:00Z" },
    ];
    const got = nudgeQuoteCandidates({ count: 1, senders: ["ai-panorama"] }, "rodcoppi", "2026-08-01T12:14:30Z", pool);
    expect(got.map((m: any) => m.body)).toEqual(["the one"]);
  });

  it("returns the N most recent, oldest first, for a multi-message knock", () => {
    const pool = [
      { from: "a", to: "x", body: "m1", createdAt: "2026-08-01T10:00:00Z" },
      { from: "a", to: "x", body: "m2", createdAt: "2026-08-01T10:05:00Z" },
      { from: "a", to: "x", body: "m3", createdAt: "2026-08-01T10:10:00Z" },
    ];
    const got = nudgeQuoteCandidates({ count: 2, senders: ["a"] }, "x", "2026-08-01T10:11:00Z", pool);
    expect(got.map((m: any) => m.body)).toEqual(["m2", "m3"]);
  });

  it("labels the turn as the switchboard's, never the operator's card", () => {
    expect(html).toContain('.chat-turn.nudge .chat-role::after { content: " / nudge"; }');
  });
});

describe("feed reaction peek", () => {
  // "✓ read" answers WHEN; the reaction answers WHAT CAME OF IT — pulled from
  // the recipient's transcript, never from new protocol messages (acks would
  // be exactly the loop the etiquette forbids).
  const pickReaction = embeddedFunction<
    (items: any[], readAtMs: number, aliases: string[]) => any | null
  >("pickReaction");
  const readAt = Date.parse("2026-08-02T12:00:00Z");

  it("prefers the entry that NAMES the sender (the narration line)", () => {
    const items = [
      { kind: "assistant", text: "unrelated progress note", ts: "2026-08-02T12:00:10Z" },
      { kind: "assistant", text: "Switchboard: agent ai.panorama says post 4 is ready — I'll publish it.", ts: "2026-08-02T12:00:40Z" },
    ];
    const hit = pickReaction(items, readAt, ["ai-panorama", "ai.panorama"]);
    expect(hit.text).toContain("I'll publish it");
  });

  it("falls back to the first assistant entry after the read", () => {
    const items = [
      { kind: "user", text: "[switchboard] 1 new message(s)…", ts: "2026-08-02T11:59:59Z" },
      { kind: "assistant", text: "On it — reworking the draft now.", ts: "2026-08-02T12:00:20Z" },
    ];
    expect(pickReaction(items, readAt, ["someone"]).text).toContain("On it");
  });

  it("answers null outside the window — never a stale unrelated turn", () => {
    const items = [
      { kind: "assistant", text: "hours later, another topic", ts: "2026-08-02T14:00:00Z" },
      { kind: "assistant", text: "before the read", ts: "2026-08-02T11:00:00Z" },
    ];
    expect(pickReaction(items, readAt, ["x"])).toBeNull();
  });

  it("only read agent-addressed rows get the peek", () => {
    const src = script.match(/function buildMsgRow[\s\S]*?\n    }/)?.[0] ?? "";
    expect(src).toContain('m.readAt && m.to !== "operator"');
  });
});

describe("bare URL linkifier", () => {
  // matchBareUrls closes over the page-level BARE_URL_RE const — rebuild the
  // pair in one scope, the same way embeddedFunctionWith does for functions.
  const reLiteral = script.match(/const BARE_URL_RE = (\/.+\/g);/)?.[1];
  if (!reLiteral) throw new Error("BARE_URL_RE not found in the page");
  let fnSrc = "";
  source.forEachChild((node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "matchBareUrls") {
      fnSrc = script.slice(node.getStart(source), node.getEnd());
    }
  });
  const matchBareUrls = new Function(
    `const BARE_URL_RE = ${reLiteral};\n${fnSrc}\nreturn matchBareUrls;`,
  )() as (text: string) => Array<{ url: string; index: number }>;

  it("finds a localhost URL and trims trailing prose punctuation", () => {
    expect(matchBareUrls("abre em http://localhost:8737/generations/images/X_V001.png .")).toEqual([
      { url: "http://localhost:8737/generations/images/X_V001.png", index: 8 },
    ]);
    expect(matchBareUrls("veja (https://example.com/a/b.html) agora")[0].url).toBe("https://example.com/a/b.html");
  });

  it("leaves plain prose and file paths alone", () => {
    expect(matchBareUrls("salvei /tmp/shot.png e pronto")).toEqual([]);
    expect(matchBareUrls("")).toEqual([]);
  });
});

describe("drag-and-drop staging", () => {
  // The real terminal's contract: dragged in means it goes up. A drop used
  // to be refused unless it was a pasted screenshot, and outside the
  // composer it NAVIGATED the browser away from the dashboard.
  it("a dropped file is never refused and a heavy one is never copied", () => {
    // v1 refused everything but screenshots; v2 staged everything (the owner:
    // "vc vai duplicar um vídeo?"); v3 refused the heavy origin-less ones.
    // v4 is the contract he asked for twice: find the original, else ASK for
    // it (native dialog, no copy) — small origin-less files still stage.
    expect(script).not.toContain("Use “Copy path” and paste it"); // v1's refusal
    expect(script).not.toContain("too big to copy");              // v3's refusal
    expect(script).toContain("askForFile(file.name, fmtBytes(file.size))");
    expect(script).toContain("staged for 24h (no original found to reference)");
  });

  it("the picker is the last resort, after the origin search", () => {
    const src = script.match(/async function attachFiles[\s\S]*?\n      }/)?.[0] ?? "";
    expect(src.indexOf("resolveDropOrigin(file)")).toBeLessThan(src.indexOf("askForFile("));
  });

  it("stray drops never navigate the dashboard away", () => {
    expect(script).toContain('window.addEventListener("dragover", (ev) => ev.preventDefault())');
    expect(script).toContain('window.addEventListener("drop", (ev) => ev.preventDefault())');
  });

  it("the terminal drop types the staged path into the pane", () => {
    const src = script.match(/async function terminalDrop[\s\S]*?\n      }/)?.[0] ?? "";
    expect(src).toContain("uploadFile(file");
    expect(src).toContain("sendScreenInput(screenState.name");
  });

  it("chat, composer and terminal announce themselves as drop zones", () => {
    expect(html).toContain("#screen-term-wrap.drop-target");
    expect(html).toContain("#screen-chat.drop-target");
  });
});

describe("autostart toggle (rail menu)", () => {
  it("every card's ⋯ menu offers the login-autostart toggle", () => {
    expect(script).toContain('"autostart-btn": "⏻"');
    expect(script).toContain("toggleAutostart(agent.name, !agent.autostart)");
    expect(script).toContain('agent.autostart ? "autostart ✓" : "autostart"');
  });

  it("the enabled state reads as data (ok green), zinc grammar", () => {
    expect(html).toContain(".autostart-btn.autostarted { color: var(--ok); }");
  });
});

describe("launch args (rail menu)", () => {
  it("the ⋯ menu offers launch args and both fields share the editor dialog", () => {
    expect(script).toContain('"cliargs-btn": "⚙"');
    expect(script).toContain('field: "cliArgs"');
    expect(script).toContain('field: "bootCommand"');
    expect(script).toContain("function showAgentFieldDialog");
  });
});

describe("drop origin resolution", () => {
  // The owner's correction of the staging-everything contract: dropping must
  // REFERENCE the original when it exists (like a real terminal drag), stage
  // only the small-and-origin-less, and never duplicate a huge file.
  it("attachFiles asks for the origin BEFORE any upload", () => {
    const src = script.match(/async function attachFiles[\s\S]*?\n      }/)?.[0] ?? "";
    expect(src.indexOf("resolveDropOrigin(file)")).toBeGreaterThan(-1);
    expect(src.indexOf("resolveDropOrigin(file)")).toBeLessThan(src.indexOf("uploadFile(file"));
    expect(src).toContain("STAGE_MAX_BYTES");
  });

  it("the terminal drop follows the same origin-first contract", () => {
    const src = script.match(/async function terminalDrop[\s\S]*?\n      }/)?.[0] ?? "";
    expect(src.indexOf("resolveDropOrigin(file)")).toBeGreaterThan(-1);
    expect(src.indexOf("resolveDropOrigin(file)")).toBeLessThan(src.indexOf("uploadFile(file"));
  });

  it("staged tokens get whitespace seams — no welded a.xlsm/home/… runs", () => {
    const src = script.match(/async function attachFiles[\s\S]*?\n      }/)?.[0] ?? "";
    expect(src).toContain("const before = at > 0");
    expect(src).toContain("before + tok + after");
  });
});

describe("WhatsApp copy — the short-tail paragraph (owner's Leatt draft)", () => {
  const toWA = embeddedFunctionWith<(text: string) => string>("toWhatsAppText", ["unwrapForWhatsApp"]);

  it("joins a two-line paragraph whose second line is the short remainder", () => {
    const out = toWA(
      "```\n" +
        "-----------\n\n" +
        "O que fica com vocês no fim não é só a ferramenta funcionando, é saber construir a\n" +
        "próxima sozinhos.\n\n" +
        "Vai ser um prazer acompanhar de perto o crescimento da Leatt.\n" +
        "```",
    );
    expect(out).toContain("construir a próxima sozinhos.");
    expect(out).not.toContain("```");
  });

  it("still leaves intentional short lines untouched", () => {
    expect(toWA("linha um\nlinha dois\nlinha três")).toBe("linha um\nlinha dois\nlinha três");
  });
});

describe("WhatsApp copy — a wrapped LIST (the case reported many times)", () => {
  const toWA = embeddedFunctionWith<(text: string) => string>("toWhatsAppText", ["unwrapForWhatsApp"]);

  // The status board an agent writes daily: bullets whose long items wrap with
  // an indented continuation. Every previous fix tuned percentages of "how
  // many lines look long" — and this block never crossed the threshold (4 of
  // 7 lines = 57%), so the breaks survived every time. The rule that actually
  // holds: an indented line continues the item above it, always.
  const board = [
    "```",
    "⌛ WAITING FOR DOCUMENTS (16)",
    "• Alvaro Roberto Torres, Ana Karla Reynoso, Eduardo Hoppenstedt,",
    "  Gaudencio Lucas Bravo, Heraclio Campana, Joaquin Uribarri,",
    "  Valentin Laime and Virgilio Reyes",
    "It is recommended that FRS to do push.",
    "```",
  ].join("\n");

  it("folds every indented continuation into its bullet", () => {
    const lines = toWA(board).split("\n");
    expect(lines).toEqual([
      "⌛ WAITING FOR DOCUMENTS (16)",
      "• Alvaro Roberto Torres, Ana Karla Reynoso, Eduardo Hoppenstedt, Gaudencio Lucas Bravo, Heraclio Campana, Joaquin Uribarri, Valentin Laime and Virgilio Reyes",
      "It is recommended that FRS to do push.",
    ]);
  });

  it("folds a SHORT wrapped bullet too — length was never the signal", () => {
    const out = toWA("• Mexico City (4): Carlos Ortiz,\n  Juan Carlos and Alejandro\n• Iron Fuentes (Bogotá)");
    expect(out.split("\n")).toEqual([
      "• Mexico City (4): Carlos Ortiz, Juan Carlos and Alejandro",
      "• Iron Fuentes (Bogotá)",
    ]);
  });

  it("leaves an unindented short list alone (one name per line stays that way)", () => {
    const list = "Carlos Ortiz\nRaúl Caraballo\nAna Karla";
    expect(toWA(list)).toBe(list);
  });
});

describe("WhatsApp copy — a link must not turn the message into 'code'", () => {
  const toWA = embeddedFunctionWith<(text: string) => string>("toWhatsAppText", ["unwrapForWhatsApp"]);

  // THE root cause behind months of "the copy still breaks lines": the code
  // sniff read the "//" of https:// as a C/JS comment marker, so any fenced
  // message carrying a link was preserved byte-for-byte — hard wraps
  // included. Every client-facing message has a link, which is why the
  // wrapping heuristics never seemed to work.
  it("unwraps a wrapped message that contains a URL", () => {
    const msg = [
      "```",
      "Fechei a proposta. Antes de escrever eu abri o relatório da NeoGrid",
      "que você me mandou e fui atrás do que ele diz de verdade. Achei uma",
      "coisa que muda a conversa: em 90 dias são 1.844 unidades.",
      "",
      "https://rodcoppi.com.br/p/comaharus/",
      "senha: *harusai*",
      "```",
    ].join("\n");
    const out = toWA(msg);
    expect(out).not.toContain("```");
    expect(out).toContain("relatório da NeoGrid que você me mandou");
    expect(out).toContain("https://rodcoppi.com.br/p/comaharus/"); // the link survives whole
  });

  it("still treats real code as code — including a REAL // comment", () => {
    const code = "```js\n// counts the rows\nconst n = rows.length;\nreturn n + 1;\n```";
    expect(toWA(code)).toBe(code);
  });
});

describe("drop is handled ONCE", () => {
  it("the textarea has no drop handler of its own — the zone would double it", () => {
    // A drop on the textarea fired its own handler AND, as the event bubbled
    // out, the composer-wide zone: one file, two attachments.
    expect(script).not.toContain('chatInput.addEventListener("drop"');
    expect(script).toContain('wireDropZone($("#chat-composer"), composerDrop)');
  });
});

describe("unwrap by exact wrap width (the rule that replaced the percentages)", () => {
  const toWA = embeddedFunctionWith<(t: string) => string>("toWhatsAppText", ["unwrapForWhatsApp"]);
  const unwrapPlain = embeddedFunctionWith<(t: string) => string>("unwrapPlain", ["unwrapForWhatsApp"]);

  // A run is unwrapped only when ONE column W explains every break: the left
  // line fits in W and the next word does not. Content whose line ends have
  // nothing to do with a margin (lists, addresses, logs, tables) survives.
  it("joins prose wrapped at a consistent column", () => {
    const wrapped = [
      "A primeira: o Canal Pro tem uma IA de atendimento própria, que já vem",
      "integrada aí. Pode ser que resolva boa parte do que você quer, e sairia",
      "mais barato que eu construir do zero.",
    ].join("\n");
    expect(unwrapPlain(wrapped)).toBe(
      "A primeira: o Canal Pro tem uma IA de atendimento própria, que já vem integrada aí. Pode ser que resolva boa parte do que você quer, e sairia mais barato que eu construir do zero.",
    );
  });

  it("leaves an address alone — no single width explains those breaks", () => {
    const address = "Rua das Flores, 123\nApto 45\nSão Paulo - SP\n01234-567";
    expect(unwrapPlain(address)).toBe(address);
  });

  it("leaves a log alone", () => {
    const log = [
      "2026-08-05T10:00:01Z INFO  started the worker pool with eight threads",
      "2026-08-05T10:00:02Z WARN  queue depth is above the configured threshold",
      "2026-08-05T10:00:03Z ERROR the upstream refused the connection, retrying",
    ].join("\n");
    expect(unwrapPlain(log)).toBe(log); // every line is long, none is a wrap
  });

  it("plain copy undoes the wrapping but never converts formatting", () => {
    const md = "Olha o **negrito** e o `código`.";
    expect(unwrapPlain(md)).toBe(md); // WA would turn ** into *
    expect(toWA(md)).toContain("*negrito*");
  });

  it("plain copy keeps a real code fence byte-for-byte", () => {
    const code = "```js\nconst a = 1;\nif (a) { run(); }\n```";
    expect(unwrapPlain(code)).toBe(code);
  });
});

describe("the copy button ON a code block", () => {
  // The button the owner actually clicks: the little "copy" floating over a
  // fenced block. It was the ONLY copy path still handing over raw text —
  // and the fenced block is exactly where an agent puts the draft message.
  it("fenced blocks get the unwrapping copy button; tool output stays verbatim", () => {
    expect(script).toContain('copyButton((code ? code.textContent : pre.textContent) || "", true)');
    expect(script).toContain("wrap.append(pre, copyButton(text));"); // tool input/result: byte-for-byte
  });

  it("copyButton unwraps only when asked", () => {
    const src = script.match(/function copyButton[\s\S]*?\n    }/)?.[0] ?? "";
    expect(src).toContain("unwrap ? unwrapPlain(text) : text");
  });
});

describe("usage gauges: colour says HOW MUCH, pace says how fast", () => {
  const gaugeColor = embeddedFunction<(p: number) => string>("gaugeColor");
  const usagePaceMark = embeddedFunctionWith<
    (p: number, e: number) => { glyph: string; color: string } | null
  >("usagePaceMark", ["usageProjected"]);
  const shade = (c: string) => (c.includes("danger") ? "red" : c.includes("warn") ? "amber" : "green");

  // The fill used to be painted by the projected PACE, so a weekly quota at
  // 10% came out RED because the week had barely started — a nearly empty bar,
  // screaming ("que que é esse vermelho embaixo", 23/08). Two facts were
  // fighting over one channel. The fill now answers what the bar asks.
  it("a barely-used quota is never alarming, however fast it started", () => {
    expect(shade(gaugeColor(10))).toBe("green"); // the reported case
    expect(shade(gaugeColor(36))).toBe("green");
    expect(shade(gaugeColor(3))).toBe("green");
  });

  it("colour climbs with what is SPENT, and nothing else", () => {
    expect(shade(gaugeColor(59))).toBe("green");
    expect(shade(gaugeColor(60))).toBe("amber");
    expect(shade(gaugeColor(84))).toBe("amber");
    expect(shade(gaugeColor(85))).toBe("red");
    expect(shade(gaugeColor(100))).toBe("red");
  });

  it("pace gets its own mark — and stays silent when there is nothing to say", () => {
    expect(usagePaceMark(10, 50)).toBeNull(); // 10% spent, half the window gone
    expect(usagePaceMark(50, 50)?.glyph).toBe("↑"); // exactly on track to finish at reset
    expect(shade(usagePaceMark(50, 50)!.color)).toBe("amber");
    expect(shade(usagePaceMark(10, 8)!.color)).toBe("red"); // lands at ~125%
  });

  it("the context pill shares the very same scale", () => {
    const contextColor = embeddedFunctionWith<(p: number) => string>("contextColor", ["gaugeColor"]);
    expect(contextColor(29)).toBe(gaugeColor(29));
    expect(contextColor(90)).toBe(gaugeColor(90));
  });
});

describe("image thumbnails in the chat", () => {
  it("pictures ride in ONE strip at the top, and the path stays in the text", () => {
    // The path is what you copy and hand to an agent, so it is never
    // replaced. The strip goes on top: a picture below the text is found
    // after you already read past it.
    const src = script.match(/function attachImageThumbs[\s\S]*?\n    }/)?.[0] ?? "";
    expect(src).toContain("/api/files/raw?path=");      // same scoped route as the preview
    expect(src).toContain('img.loading = "lazy"');
    expect(src).toContain("container.insertBefore(strip, container.firstChild)");
    expect(src).toContain("THUMBS_PER_MESSAGE");        // a wall of pictures is not a chat
  });

  it("thumbnails are square crops — a panorama must stay legible", () => {
    expect(html).toContain("object-fit: cover;      /* square crop: a panorama stays legible */");
    expect(html).toContain("width: 112px;");
    expect(html).toContain("height: 112px;");
  });

  it("a missing image drops its thumbnail, and an empty strip disappears", () => {
    const src = script.match(/function attachImageThumbs[\s\S]*?\n    }/)?.[0] ?? "";
    expect(src).toContain("img.remove();");
    expect(src).toContain("if (strip && !strip.childElementCount) strip.remove();");
  });

  it("the chip carries the RESOLVED path — a relative one would 404", () => {
    expect(script).toContain("link.dataset.fullPath = full;");
  });
});

describe("reply/quote a message", () => {
  // The function reads window.getSelection(); node has no window, so the
  // "nothing selected" case is stubbed — the selected case is exercised live
  // in the browser (a real Range cannot be faked meaningfully here).
  const quoteExcerptFrom = ((): ((turn: any) => string) => {
    let src = "";
    source.forEachChild((node) => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === "quoteExcerptFrom") {
        src = script.slice(node.getStart(source), node.getEnd());
      }
    });
    return new Function(
      "window",
      `const QUOTE_MAX = 220;\n${src}\nreturn quoteExcerptFrom;`,
    )({ getSelection: () => null }) as (turn: any) => string;
  })();
  const fakeTurn = (text: string) => ({ __text: text, contains: () => false });

  // The anchor must be WORDS: the agent re-reads its own conversation, where
  // it sees text — not clock times, not our internal ids. So the quote is a
  // short excerpt, never the whole message (the owner's case: replying to one
  // paragraph of a long answer without pasting the answer back).
  it("keeps a long message down to an excerpt", () => {
    const long = "palavra ".repeat(400);
    const out = quoteExcerptFrom(fakeTurn(long));
    expect(out.length).toBeLessThanOrEqual(230);
    expect(out.endsWith("…")).toBe(true);
  });

  it("quotes a short message whole (nothing to trim)", () => {
    expect(quoteExcerptFrom(fakeTurn("beleza, pode seguir"))).toBe("beleza, pode seguir");
  });

  it("collapses newlines so the quote stays one line", () => {
    expect(quoteExcerptFrom(fakeTurn("uma\n\nlinha\ne outra"))).toBe("uma linha e outra");
  });

  it("cuts on a word boundary, never mid-word", () => {
    const out = quoteExcerptFrom(fakeTurn("abcdefghij ".repeat(40)));
    // Every word that survived is a WHOLE one: no "abcdef…" fragments.
    for (const w of out.replace(/…$/, "").trim().split(/\s+/)) {
      expect(w).toBe("abcdefghij");
    }
  });

  it("the composer gets a quote block, not the message", () => {
    const src = script.match(/function quoteTurnIntoComposer[\s\S]*?\n    }/)?.[0] ?? "";
    expect(src).toContain("> ↩ ${who}: ${excerpt}");
    expect(src).toContain("input.value = block + input.value.replace"); // replaces a previous quote
  });
});

describe("the agent's question in the chat", () => {
  it("the composer refuses to type into a pane a dialog owns", () => {
    // Before: the message looked sent and vanished — worse, its Enter could
    // land on the highlighted choice.
    const src = script.match(/async function sendChatMessage[\s\S]*?\n    }/)?.[0] ?? "";
    expect(src).toContain("live && live.blocked");
    expect(src).toContain("waiting on a question in its terminal");
  });

  it("the question is surfaced with its choices as buttons", () => {
    const src = script.match(/function updateChatAsk[\s\S]*?\n    }/)?.[0] ?? "";
    expect(src).toContain("agent.blockedOptions");
    expect(src).toContain("answerAgentAsk(screenState.name, i + 1)");
    expect(src).toContain("dataset.signature"); // survives re-renders unchanged
  });

  it("the panel is re-derived after a chat render, like the reopen spinner", () => {
    expect(script).toContain("renderChat(view, items);\n        // Re-derive the pinned surfaces");
  });
});

// ---------------------------------------------------------------------------
// Agent-to-agent traffic in the chat. The two MCP calls that ARE the network's
// conversation (send_message / check_messages) must read as MESSAGES, not as
// tool chips: the incoming half already unfolded under the nudge's blue peek
// while the outgoing half sat collapsed behind "mcp__switchboard__send_message"
// and the incoming result showed as raw JSON.
// ---------------------------------------------------------------------------

describe("switchboardTraffic", () => {
  // Closes over two page-level consts and two helpers — rebuild the scope, the
  // same way the BARE_URL_RE block above does.
  const fnNames = new Set(["switchboardTraffic", "jsonish"]);
  const srcs: string[] = [];
  source.forEachChild((node) => {
    if (ts.isFunctionDeclaration(node) && node.name && fnNames.has(node.name.text)) {
      srcs.push(script.slice(node.getStart(source), node.getEnd()));
    }
  });
  if (srcs.length !== 2) throw new Error(`expected 2 functions, found ${srcs.length}`);
  const traffic = new Function(
    `const SB_SEND_TOOL = "mcp__switchboard__send_message";
     const SB_CHECK_TOOL = "mcp__switchboard__check_messages";
     const displayOf = (n) => String(n);
     const fmtStamp = () => "11:08 AM";
     ${srcs.join("\n")}
     return switchboardTraffic;`,
  )() as (it: Record<string, unknown>) => null | {
    dir: string;
    line: string;
    show: string;
    quotes: Array<{ head: string; body: string }>;
  };

  it("a send reads as the message it is, addressed and quotable", () => {
    const got = traffic({
      name: "mcp__switchboard__send_message",
      input: { to: "roteirista", message: "corte do S21 aplicado, md5 confere" },
      result: '{"ok":true,"delivery":"nudged"}',
    });
    expect(got).toEqual({
      dir: "out",
      line: "Sent a message to roteirista.",
      show: "show what was sent ▸",
      hide: "hide what was sent ▾",
      quotes: [{ head: "→ roteirista", body: "corte do S21 aplicado, md5 confere" }],
    });
  });

  it("a REFUSED send is not traffic — the chip's error state tells it better", () => {
    const refused = { name: "mcp__switchboard__send_message", input: { to: "x", message: "oi" } };
    expect(traffic({ ...refused, result: '{"ok":false,"error":"rate limit"}' })).toBeNull();
    expect(traffic({ ...refused, result: "{}", isError: true })).toBeNull();
  });

  it("check_messages unfolds every message that came in, by sender", () => {
    const got = traffic({
      name: "mcp__switchboard__check_messages",
      result: JSON.stringify({
        ok: true,
        messages: [
          { id: "1", from: "operator", body: "RODADA DE SEXTA", created_at: "2026-08-21T14:08:19.835Z" },
          { id: "2", from: "vide-editor", body: "capa conferida", created_at: "2026-08-21T14:09:00.000Z" },
        ],
      }),
    });
    expect(got?.dir).toBe("in");
    expect(got?.line).toBe("Read 2 messages from operator, vide-editor.");
    expect(got?.show).toBe("show what operator, vide-editor sent ▸");
    expect(got?.quotes).toEqual([
      { head: "operator · 11:08 AM", body: "RODADA DE SEXTA" },
      { head: "vide-editor · 11:08 AM", body: "capa conferida" },
    ]);
  });

  it("one message says message, not messages", () => {
    const got = traffic({
      name: "mcp__switchboard__check_messages",
      result: JSON.stringify({ ok: true, messages: [{ from: "operator", body: "oi" }] }),
    });
    expect(got?.line).toBe("Read 1 message from operator.");
  });

  it("an empty check is left as a plain chip (no card for nothing)", () => {
    expect(
      traffic({ name: "mcp__switchboard__check_messages", result: '{"ok":true,"messages":[]}' }),
    ).toBeNull();
    expect(traffic({ name: "mcp__switchboard__check_messages", result: "not json" })).toBeNull();
  });

  it("every other tool keeps its chip", () => {
    expect(traffic({ name: "Bash", input: { command: "ls" }, result: "a\nb" })).toBeNull();
    expect(traffic({ name: "mcp__switchboard__list_agents", result: '{"ok":true}' })).toBeNull();
  });
});

describe("message stamps carry the day once they are not today", () => {
  // Every stamp was time-only, which reads fine for the last hour and becomes
  // a riddle for anything older: a thread spanning days showed three "11:21"s
  // with no way to tell them apart (owner, 27/08).
  const fmtStamp = embeddedFunctionWith<(iso: string, now?: number) => string>("fmtStamp", [
    "fmtTime",
    "startOfDay",
  ]);
  const now = new Date("2026-08-27T15:00:00").getTime();

  it("today shows the time alone — that is most of what you ever read", () => {
    expect(fmtStamp("2026-08-27T11:21:00", now)).not.toMatch(/\d\d\/\d\d/);
    expect(fmtStamp("2026-08-27T11:21:00", now)).toMatch(/11.21/);
  });

  it("any earlier day puts the date in front of it", () => {
    const y = fmtStamp("2026-08-26T11:21:00", now);
    expect(y).toMatch(/\d\d\/\d\d/);
    expect(y).toMatch(/11.21/);
    expect(fmtStamp("2026-07-11T21:27:00", now)).toMatch(/\d\d\/\d\d/);
  });

  it("another year says so, without spelling out the century", () => {
    const old = fmtStamp("2025-12-31T23:59:00", now);
    expect(old).toMatch(/25/); // two-digit year
    expect(old).not.toMatch(/2025/);
  });

  it("a garbage timestamp is returned as-is, never as 'Invalid Date'", () => {
    expect(fmtStamp("not a date", now)).toBe("not a date");
    expect(fmtStamp("", now)).toBe("");
  });
});

describe("blob faces: shape is the agent, expression is the state", () => {
  const blobHash = embeddedFunction<(s: string) => number>("blobHash");
  const blobVariantOf = embeddedFunctionWith<(n: string, s: string) => number>("blobVariantOf", [
    "blobHash",
  ]);

  // The rail repaints on every SSE event. A variant drawn at random each time
  // would restart the animation mid-cycle — a twitch on every card, on every
  // message — so the choice has to be a seed, not a roll.
  it("the same agent and state always land on the same variant", () => {
    expect(blobVariantOf("roteirista", "idle")).toBe(blobVariantOf("roteirista", "idle"));
    expect(blobVariantOf("roteirista", "working")).toBe(blobVariantOf("roteirista", "working"));
  });

  it("different agents in the SAME state do not move in unison", () => {
    const names = ["roteirista", "secretario", "vide-editor", "ai-panorama", "rodcoppi", "media-gen"];
    const picks = new Set(names.map((n) => blobVariantOf(n, "idle") % 3));
    expect(picks.size).toBeGreaterThan(1); // the whole point of the variants
  });

  it("one agent varies its rhythm from state to state", () => {
    const states = ["idle", "working", "speaking", "thinking", "asking", "waiting", "reply"];
    const picks = new Set(states.map((s) => blobVariantOf("roteirista", s) % 3));
    expect(picks.size).toBeGreaterThan(1);
  });

  it("the hash is stable across restarts (no Math.random, no Date)", () => {
    expect(blobHash("alpha")).toBe(blobHash("alpha"));
    expect(blobHash("alpha")).not.toBe(blobHash("beta"));
    const src = script.match(/function blobHash[\s\S]*?\n    }/)?.[0] ?? "";
    expect(src).not.toContain("Math.random");
    expect(src).not.toContain("Date");
  });

  it("every state's loops close on themselves (0% === 100%)", () => {
    // A loop whose ends differ shows a jump once per cycle — which is exactly
    // what the pixel-literal keyframes did on a 22px face.
    const frames = [...styles.matchAll(/@keyframes (bl-[\w-]+)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g)];
    expect(frames.length).toBeGreaterThan(15);
    for (const [, name, body] of frames) {
      if (["bl-zzz", "bl-ring"].includes(name)) continue; // one-shot cues, not loops
      const stops = new Map<string, string>();
      for (const [, sel, decl] of body.matchAll(/([\d.%,\s]+)\{([^}]*)\}/g)) {
        for (const one of sel.split(",")) {
          const sk = one.trim();
          if (sk) stops.set(sk, decl.trim());
        }
      }
      expect(stops.get("0%"), `${name} has no 0% stop`).toBeDefined();
      expect(stops.get("100%"), `${name} has no 100% stop`).toBeDefined();
      expect(stops.get("100%"), `${name} does not return to where it started`).toBe(stops.get("0%"));
    }
  });

  it("no keyframe moves by a raw pixel any more — everything scales with --blk", () => {
    // The study is authored at 150px; a literal "-7px" is 5% there and 32% on a
    // 22px rail portrait, which is what read as a jump.
    const frames = [...styles.matchAll(/@keyframes (bl-[\w-]+)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g)];
    for (const [, name, body] of frames) {
      if (name === "bl-zzz") continue; // scales off --zk, its own factor
      // Drop every calc() that scales off one of the face variables; whatever
      // pixels are left are literal ones.
      const scrubbed = body
        .replace(/calc\([^()]*var\(--bl[kg][^()]*\)[^()]*\)/g, "")
        .replace(/var\(--bl[kg][^()]*\)/g, "");
      expect(scrubbed, `${name} translates by a literal pixel`).not.toMatch(/[\d.]px/);
    }
  });
});

describe("faces survive the rail's rebuild", () => {
  // The rail wipes and rebuilds itself on every activity poll (~2.5s), so each
  // face is a brand new element whose animation would restart at 0%. That is
  // what read as a jump — not a bad keyframe, a loop that never finished.
  const splitTopLevel = embeddedFunction<(css: string) => string[]>("splitTopLevel");

  it("splits an animation list without breaking cubic-bezier apart", () => {
    expect(splitTopLevel("bl-nod 2.4s cubic-bezier(.3,1.5,.4,1) infinite")).toEqual([
      "bl-nod 2.4s cubic-bezier(.3,1.5,.4,1) infinite",
    ]);
    expect(
      splitTopLevel("bl-wobble 7s ease-in-out infinite, bl-float 7s ease-in-out infinite"),
    ).toHaveLength(2);
    expect(
      splitTopLevel("bl-nod 2.9s cubic-bezier(.3,1.5,.4,1) infinite, bl-lilt 3.4s ease-in-out infinite"),
    ).toHaveLength(2);
  });

  it("animateSynced starts each loop mid-cycle, one delay per animation", () => {
    const animateSynced = embeddedFunctionWith<
      (node: { style: Record<string, string> }, css: string, base?: number[]) => void
    >("animateSynced", ["splitTopLevel"]);
    const node = { style: {} as Record<string, string> };
    animateSynced(node, "bl-wobble 7s ease-in-out infinite, bl-float 7s ease-in-out infinite");
    expect(node.style.animation).toContain("bl-wobble");
    const delays = node.style.animationDelay.split(",").map((d) => parseFloat(d));
    expect(delays).toHaveLength(2);
    // Negative and inside the cycle: it resumes, never jumps ahead.
    for (const d of delays) {
      expect(d).toBeLessThanOrEqual(0);
      expect(d).toBeGreaterThan(-7.001);
    }
  });

  it("keeps a stagger that the design put there on purpose (the z's)", () => {
    const animateSynced = embeddedFunctionWith<
      (node: { style: Record<string, string> }, css: string, base?: number[]) => void
    >("animateSynced", ["splitTopLevel"]);
    const a = { style: {} as Record<string, string> };
    const b = { style: {} as Record<string, string> };
    animateSynced(a, "bl-zzz 3.4s ease-out infinite", [0]);
    animateSynced(b, "bl-zzz 3.4s ease-out infinite", [1.1]);
    const da = parseFloat(a.style.animationDelay);
    const db = parseFloat(b.style.animationDelay);
    expect(db - da).toBeCloseTo(1.1, 2); // same phase shift the study had
  });

  it("the eyes are never inside the clipped shape", () => {
    // clip-path cuts everything inside it, so a hexagon or a triangle would
    // slice its own eyes off at the corners.
    const src = script.match(/function blobFace[\s\S]*?\n    }/)?.[0] ?? "";
    expect(src).toContain("skin.append(body, pupils)"); // siblings, not nested
    expect(src).not.toMatch(/body\.appendChild\(pupils\)/);
  });
});
