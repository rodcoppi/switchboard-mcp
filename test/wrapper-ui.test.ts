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
  it("dropping stages the SMALL and origin-less — no blanket refusal, no blanket copy", () => {
    // v1 refused everything but screenshots; v2 staged everything (the owner:
    // "vc vai duplicar um vídeo?"); v3 is the contract: origin first, stage
    // small, refuse huge with advice.
    expect(script).not.toContain("Use “Copy path” and paste it"); // v1's blanket refusal
    expect(script).toContain("staged for 24h (no original found to reference)");
    expect(script).toContain("too big to copy");
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
