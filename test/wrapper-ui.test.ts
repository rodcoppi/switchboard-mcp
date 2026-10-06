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
/** The raw text of one embedded function — for contracts a UI function cannot be run to prove. */
function embeddedFunctionSource(name: string): string {
  let found: ts.FunctionDeclaration | undefined;
  source.forEachChild((node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
  });
  if (!found) throw new Error(`Embedded function ${name} not found`);
  return script.slice(found.getStart(source), found.getEnd());
}

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

describe("wrapper wake loading state", () => {
  // Behavior, not units: the rail re-renders on every SSE event, so a wake
  // in flight must be re-derivable from state (state.reopening), never from a
  // label mutated on the live button node — the old version blinked back to
  // its idle label mid-launch and looked dead. Source-level contract assertions.

  it("reopenAgent tracks the in-flight launch in state and re-renders on settle", () => {
    const src = embeddedFunctionSource("reopenAgent");
    expect(src).toContain("state.reopening.add(agent.name)");
    expect(src).toContain("state.reopening.delete(agent.name)");
    // The finally must re-render (the clicked node may be orphaned), not
    // poke the possibly-dead node back to its idle label.
    expect(src).toContain("renderAgents()");
    expect(src).not.toContain('btn.textContent = "wake"');
    // Double-click guard.
    expect(src).toContain("if (state.reopening.has(agent.name)) return;");
  });

  it("the card renderer derives the busy button from state.reopening", () => {
    const src = embeddedFunctionSource("buildAgentCard");
    expect(src).toContain("state.reopening.has(agent.name)");
    expect(src).toContain('"reopen-btn busy"');
    expect(src).toContain('"waking…"');
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
    // (The open-menu check looks at the whole document now: an open menu
    // floats in <body>, outside the rail.)
    expect(html).toContain('container.querySelector(".agent-rename-input") || document.querySelector(".agent-menu:not([hidden])")');
  });
});

// ---------------------------------------------------------------------------
// Clicking an agent that is NOT running. It used to bounce you to that agent's
// traffic filter, and forcing the panel open landed on the conversation
// endpoint's "no conversation log" (there is no log to tail) or on a terminal
// attached to a session that no longer exists. All three answer something
// other than the click. The panel owes: it is off, this is its folder, here is
// the way back.
// ---------------------------------------------------------------------------

describe("wake screen for a sleeping agent", () => {
  /** presenceKey, with a fake registry — the one bit of this that is pure logic. */
  function presenceKeyWith(agents: Record<string, { status: string }>, waking: string[]) {
    return new Function(
      `const state = { agents: new Map(Object.entries(arguments[0])), reopening: new Set(arguments[1]) };
       ${embeddedFunctionSource("presenceKey")}
       return presenceKey;`,
    )(agents, waking) as (name: string) => string;
  }

  it("presenceKey separates asleep, waking and awake", () => {
    const key = presenceKeyWith({ beta: { status: "offline" }, alfa: { status: "online" } }, []);
    expect(key("beta")).toBe("asleep");
    expect(key("alfa")).toBe("awake");
    // An agent the rail has not heard of yet must not be declared asleep —
    // that would put a wake button under a name nobody can launch.
    expect(key("ghost")).toBe("awake");
  });

  it("a wake in flight is its own presence, so the screen can show progress", () => {
    const key = presenceKeyWith({ beta: { status: "offline" } }, ["beta"]);
    expect(key("beta")).toBe("asleep-waking");
  });

  it("the pinned chat surfaces refuse a pane that is gone", () => {
    // Going offline does NOT clear activity/blocked/composerBusy on the record
    // (dispatcher.markOffline only flips status), so every surface that types
    // into a pane has to ask whether the pane is still there.
    const live = new Function(
      `const state = { agents: new Map(Object.entries(arguments[0])) };
       const screenState = { name: arguments[1] };
       ${embeddedFunctionSource("liveScreenAgent")}
       return liveScreenAgent;`,
    )({ beta: { name: "beta", status: "offline", blocked: true, blockedOptions: ["1. yes"] } }, "beta") as () => unknown;
    expect(live()).toBeNull();
  });

  it("clicking the card opens the screen whatever the agent's status is", () => {
    const src = embeddedFunctionSource("buildAgentCard");
    expect(src).toContain("const activateCard = () => openScreen(agent.name);");
  });

  it("setScreenMode mounts the wake screen instead of a stream when the agent is off", () => {
    const src = embeddedFunctionSource("setScreenMode");
    const cut = src.indexOf('if (mode === "terminal")');
    const branch = src.slice(0, cut);
    expect(branch).toContain('agent.status !== "online"');
    expect(branch).toContain("mountWakeScreen(agent)");
    expect(branch).toContain("return;"); // neither stream is reached
    expect(branch).not.toContain("mountChat(");
    expect(branch).not.toContain("mountTerminal(");
    // Nothing to type into: the composer would send-keys into a dead pane.
    expect(branch).toContain('$("#chat-composer").hidden = true');
  });

  it("the wake screen offers the same relaunch the card's button does, with the context to decide", () => {
    const src = embeddedFunctionSource("mountWakeScreen");
    expect(src).toContain("reopenAgent(agent, btn)"); // one path, one guard, one toast
    expect(src).toContain("agent.cwd"); // which folder comes back
    expect(src).toContain("fmtAgo(seen)"); // how stale it is
    expect(src).toContain("agent.unreadCount"); // what is queued behind it
    // Busy is DERIVED, so a wake started from the card already reads as in
    // flight when you open the panel (same rule as the rail's button).
    expect(src).toContain("state.reopening.has(agent.name)");
  });

  it("the panel re-derives its presence on every rail repaint, before the menu guard", () => {
    // The guard protects the rail's DOM from a rebuild mid-menu; the panel
    // must not stay on a stale screen just because a card's menu is open.
    const src = embeddedFunctionSource("renderAgents");
    const sync = src.indexOf("syncScreenPresence()");
    expect(sync).toBeGreaterThan(-1);
    expect(sync).toBeLessThan(src.indexOf('.agent-menu:not([hidden])'));
  });

  it("the rebuild only fires when the presence the panel was built for changed", () => {
    const src = embeddedFunctionSource("syncScreenPresence");
    expect(src).toContain("=== screenState.presence");
    expect(src).toContain("setScreenMode(screenState.mode");
  });

  it("the wake block borrows .chat-ask's styling without joining the class", () => {
    // updateChatAsk removes every .chat-ask it did not build itself, so the
    // wake block reuses the RULE and keeps its own class.
    expect(styles).toContain(".chat-ask, .chat-wake {");
    expect(styles).toContain(".chat-wake .chat-ask-eyebrow");
    // …and the spinner is the rail button's, not a second one.
    expect(styles).toContain(".reopen-btn.busy::before, .chat-wake-btn.busy::before");
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
  it("every card's menu offers the login-autostart toggle, as a switch", () => {
    expect(script).toContain('label: "Start with Windows", cls: "autostart-btn", toggle: autostart');
    expect(script).toContain("toggleAutostart(agent.name, autostart)");
  });

  it("the on state reads as data (ok green) on the switch, not in the label", () => {
    expect(html).toMatch(/\.agent-menu \.on > \.mi-switch \{[^}]*var\(--ok\)/);
  });
});

describe("launch args (rail menu)", () => {
  it("the menu offers launch args and both fields share the editor dialog", () => {
    expect(script).toContain('label: "Launch args…", cls: "cliargs-btn"');
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
    // Every token (pending placeholder and final) goes in through insertAtCaret.
    const insert = script.match(/function insertAtCaret[\s\S]*?\n      }/)?.[0] ?? "";
    expect(insert).toContain("const before = at > 0");
    expect(insert).toContain("before + text + after");
    const src = script.match(/async function attachFiles[\s\S]*?\n      }/)?.[0] ?? "";
    expect(src).toContain("insertAtCaret(pending)");
  });

  it("shows a token at once and resolves the files in parallel", () => {
    // Serial, invisible resolution made five screenshots take ~12 s to show
    // anything (compared against the cousin's app, 23/09).
    const src = script.match(/async function attachFiles[\s\S]*?\n      }/)?.[0] ?? "";
    expect(src).toContain("Promise.all(jobs.map(");
    expect(src.indexOf("insertAtCaret(pending)")).toBeLessThan(src.indexOf("Promise.all("));
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

describe("the colour & shape panel", () => {
  // One panel replaced a loose swatch popover and a menu row you clicked to
  // cycle the shape blind (owner, 29/09: "deixa melhor o seletor de cor e
  // formato").
  const fn = script.match(/function openLookPicker\(name\) \{[\s\S]*?\n    }/)?.[0] ?? "";

  it("is opened by a single menu row, which closes the menu first", () => {
    expect(script).toContain('"colour & shape…"');
    expect(script).toMatch(/closeMenus\(\); \/\/ the panel stands alone[\s\S]{0,60}openLookPicker\(agent\.name\)/);
    // The blind shape-cycling row is gone.
    expect(script).not.toContain('`shape · ${blobShapeOf(agent.name)}`');
  });

  it("previews live and draws every shape as a small face in the chosen colour", () => {
    expect(fn).toContain("const preview = Faces.createFace(previewBox");
    expect(fn).toMatch(/for \(const sh of BLOB_SHAPE_NAMES\)[\s\S]*?Faces\.createFace\(box/);
  });

  it("applies a pick straight to the live face, not through a rail rebuild", () => {
    // renderAgents refuses to run while a menu is open, which once made the
    // shape switcher store a pick and change nothing on screen (28/08).
    expect(fn).toContain("if (entry) entry.face.setShape(sh)");
    expect(fn).toContain("for (const f of faces) f.setColor(color)");
    expect(fn).toContain("setChatColor(name, c)");
  });

  it("frees its engine faces when it closes", () => {
    const close = script.match(/function closeLookPicker\(\) \{[\s\S]*?\n    }/)?.[0] ?? "";
    expect(close).toContain("for (const f of lookState.faces) f.destroy()");
  });

  it("is a bottom sheet on a phone", () => {
    expect(fn).toMatch(/matchMedia\("\(max-width: 640px\), \(hover: none\)"\)/);
    expect(styles).toMatch(/\.look-pop\.sheet \{[^}]*bottom: 0/);
  });

  it("sits above the dashboard like the other panels", () => {
    expect(styles).toMatch(/\.look-pop \{[^}]*z-index: 70/);
  });
});

describe("the terminal's wheel", () => {
  // The pane has no scrollback (alternate screen), so only the CLI's own
  // buffer can scroll. While the app has mouse reporting on, xterm forwards
  // the wheel to it and the app decides what it means — which stopped being
  // "scroll the transcript" when a build started spending those events on its
  // background-agents panel (owner, 28/08: "roda entre os subagentes").
  const src = script.match(/termEl\.addEventListener\([\s\S]*?\{ passive: false \},\s*\);/)?.[0] ?? "";

  it("sends PageUp / PageDown, the keys that page the transcript", () => {
    expect(src).toContain("\\x1b[5~"); // PageUp, scrolling back
    expect(src).toContain("\\x1b[6~"); // PageDown
    expect(src).toContain("ev.deltaY < 0");
  });

  it("shift+wheel still hands the raw event to the app", () => {
    expect(src).toMatch(/if \(ev\.shiftKey\) return;/);
  });

  it("cannot be swallowed by the passive default", () => {
    // preventDefault only works on a non-passive listener.
    expect(src).toContain("{ passive: false }");
    expect(src).toContain("ev.preventDefault()");
  });

  it("rate-limits, so a trackpad does not page ten screens at once", () => {
    expect(src).toMatch(/now - lastWheel < \d+/);
  });
});

describe("the rail's agent filter", () => {
  // The rail is torn down and rebuilt every ~2.5s, so the piece worth pinning
  // is the decision itself: given an agent and a query, does its card stay?
  // Evaluated in one scope because it leans on displayOf/groupOf and the
  // DEFAULT_GROUP const — same trick as the CLI_BUILTIN_COMMANDS block above.
  const defaultGroup = script.match(/const DEFAULT_GROUP = "[^"]*";/)?.[0];
  if (!defaultGroup) throw new Error("DEFAULT_GROUP not found in the page");
  const wanted = ["agentMatchesQuery", "foldSearch", "displayOf", "groupOf"];
  const fns: string[] = [];
  source.forEachChild((node) => {
    if (ts.isFunctionDeclaration(node) && node.name && wanted.includes(node.name.text)) {
      fns.push(script.slice(node.getStart(source), node.getEnd()));
    }
  });
  if (fns.length !== wanted.length) {
    throw new Error(`expected ${wanted.length} embedded functions, found ${fns.length}`);
  }
  const matches = new Function(`${defaultGroup}\n${fns.join("\n")}\nreturn agentMatchesQuery;`)() as (
    agent: Record<string, unknown>,
    query: string,
  ) => boolean;

  const renderAgentsSrc = (() => {
    let found: ts.FunctionDeclaration | undefined;
    source.forEachChild((node) => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === "renderAgents") found = node;
    });
    if (!found) throw new Error("renderAgents not found in the page");
    return script.slice(found.getStart(source), found.getEnd());
  })();

  const roteirista = {
    name: "video-roteiro",
    displayName: "🎬 Roteirista",
    role: "Roteirista de vídeo, cuida da narração",
    group: "conteudo",
  };

  it("keeps everyone while the box is empty — blank is not a filter", () => {
    expect(matches(roteirista, "")).toBe(true);
    expect(matches(roteirista, "   ")).toBe(true);
  });

  it("matches the four things the card puts on screen", () => {
    expect(matches(roteirista, "video-roteiro")).toBe(true); // the id
    expect(matches(roteirista, "Roteirista")).toBe(true); // the display name
    expect(matches(roteirista, "narração")).toBe(true); // the role line
    expect(matches(roteirista, "conteudo")).toBe(true); // the room
    expect(matches(roteirista, "postgres")).toBe(false);
  });

  it("ignores case and accents, because the owner types Portuguese flat", () => {
    expect(matches(roteirista, "ROTEIRISTA")).toBe(true);
    expect(matches(roteirista, "roteirista")).toBe(true);
    expect(matches(roteirista, "narracao")).toBe(true); // typed without the ç/ã
    expect(matches({ ...roteirista, role: "Revisao de codigo" }, "revisão")).toBe(true);
  });

  it("does not choke on an agent with no role and no group", () => {
    expect(matches({ name: "solo" }, "solo")).toBe(true);
    expect(matches({ name: "solo" }, "default")).toBe(true); // groupOf's fallback
    expect(matches({ name: "solo" }, "roteiro")).toBe(false);
  });

  it("names the rail after what is in it", () => {
    expect(html).toContain('<span class="eyebrow">Agents</span>');
    expect(html).not.toContain(">Patchbay<");
  });

  it("puts the box outside the container the poll wipes", () => {
    // renderAgents() empties #agents every ~2.5s; an input in there would be
    // destroyed mid-word, the way the rename input was before its guard.
    const head = html.match(/<div class="sidebar-head">[\s\S]*?<\/div>/)?.[0] ?? "";
    expect(head).toContain('id="rail-search"');
    expect(renderAgentsSrc).not.toContain("rail-search");
  });

  it("hides rooms a search emptied, and says so when nothing is left", () => {
    // (With subgroups a room counts its clients too: a family is hidden only
    // when the search emptied the parent AND every client inside it.)
    expect(renderAgentsSrc).toContain("if (query && child.count === 0) continue;");
    expect(renderAgentsSrc).toContain("if (query && shown === 0) continue;");
    expect(renderAgentsSrc).toContain("No agent matches");
    // Without a search an empty group keeps its header (a room you just named).
    expect(renderAgentsSrc).toContain("const query = state.railSearch.trim();");
  });

  it("is view state, stored nowhere", () => {
    expect(script).toContain('railSearch: ""');
    expect(script).not.toMatch(/localStorage[^\n]*railSearch/);
    expect(script).not.toContain("sb.railSearch");
  });

  it("clears on Escape without taking the key away from the page", () => {
    const wiring = script.match(/\$\("#rail-search"\)\.addEventListener\("keydown"[\s\S]*?\n {6}\}\);/)?.[0] ?? "";
    expect(wiring).toContain('if (e.key !== "Escape" || !e.target.value) return;');
    expect(wiring).toContain("e.stopPropagation();");
    // Its own two listeners are all there is: nothing document-level reaches
    // for the box, so it claims no key from the palette (⌘K) or the composer.
    expect(script.match(/\$\("#rail-search"\)/g)?.length).toBe(2);
  });
});

describe("the transcript filter kept a door", () => {
  // Clicking an OFFLINE card used to filter the transcript to that agent — the
  // only way in, and undiscoverable at that. That click now opens the wake
  // screen, which is what you want from a sleeping agent, so the filter needed
  // an entry of its own instead of quietly disappearing.
  it("lives in the agent's menu", () => {
    const at = script.indexOf('cls: "filter-btn"');
    expect(at, "the filter menu item is gone").toBeGreaterThan(-1);
    const item = script.slice(at, at + 300);
    expect(item).toContain("setFilter(agent.name)");
    expect(item).toContain("act("); // closes the menu: the transcript is elsewhere on screen
  });

  it("is not reachable ONLY by the clear button any more", () => {
    const calls = [...script.matchAll(/setFilter\(/g)].length;
    expect(calls).toBeGreaterThanOrEqual(3); // definition + clear + the menu item
  });
});

describe("reduce-motion is surfaced, not silently obeyed", () => {
  // One Windows toggle makes Chrome report the flag, and the page's own
  // reduced-motion rule then kills every animation with !important — faces
  // included — while saying nothing. That is how an evening goes into making
  // the idle motion bolder against a browser throwing all of it away.
  it("the blanket rule can be overridden by the operator", () => {
    const rule = styles.match(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\n    \}/)?.[0] ?? "";
    expect(rule).toContain("html:not(.force-motion)");
  });

  it("the dashboard says so, and offers the switch", () => {
    const src = script.match(/function initMotionPreference[\s\S]*?\n    }/)?.[0] ?? "";
    expect(src).toContain('matchMedia("(prefers-reduced-motion: reduce)")');
    expect(src).toContain("toastAction(");
    expect(src).toContain("force-motion");
  });

  it("it obeys by default — the override is a choice, not a default", () => {
    const src = script.match(/function initMotionPreference[\s\S]*?\n    }/)?.[0] ?? "";
    // The class is only added from storage or from the button's handler.
    const adds = [...src.matchAll(/classList\.add\("force-motion"\)/g)];
    expect(adds).toHaveLength(2);
    expect(src).toContain('localStorage.getItem(MOTION_KEY) === "1"');
  });

  it("it says it once per session, not on every reconnect", () => {
    const src = script.match(/function initMotionPreference[\s\S]*?\n    }/)?.[0] ?? "";
    expect(src).toContain("sessionStorage");
  });

  it("runs before anything animates", () => {
    const boot = script.match(/async function boot\(\) \{[\s\S]{0,200}/)?.[0] ?? "";
    expect(boot).toContain("initMotionPreference()");
  });
});

describe("the rail stops cancelling its own animations", () => {
  // Wiping the container removes every card from the document, and removing a
  // node cancels its running CSS animations. With 31 call sites firing on
  // every SSE event, poll and nudge, a 1.5s spin was cancelled mid-turn and a
  // 3s breath restarted several times a second: it looked like nothing moved
  // because nothing ever got to (owner, 30/08).
  const render = script.match(/function renderAgents\(\) \{[\s\S]*?\n      container\.textContent = "";/)?.[0] ?? "";

  it("bails out before touching the DOM when nothing changed", () => {
    expect(render).toContain("const signature = railSignature()");
    expect(render).toMatch(/if \(signature === lastRailSignature && container\.firstChild\) return;/);
    // …and the bail-out comes BEFORE the wipe, or it would be pointless.
    expect(render.indexOf("railSignature()")).toBeLessThan(render.indexOf('container.textContent = ""'));
  });

  it("the signature covers everything a card can show", () => {
    const sig = script.match(/function railSignature\(\) \{[\s\S]*?\n    }/)?.[0] ?? "";
    for (const field of [
      "a.status", "a.activity", "a.phase", "blobStateOf(a)", "groupOf(a)", "a.unreadCount",
      "a.muted", "displayOf(a)", "a.role", "agentTypeOf(a)", "a.waitingFor", "a.blocked",
      "blobShapeOf(a.name)",
    ]) {
      expect(sig, `${field} is missing — the rail would go stale`).toContain(field);
    }
    // View state that changes what is drawn, not just which data exists.
    for (const field of ["state.filter", "state.railSearch", "screenState.name", "state.reopening", "state.unseen", "collapsedGroups"]) {
      expect(sig, `${field} is missing`).toContain(field);
    }
  });

});

/**
 * The dashboard on a folding phone.
 *
 * The Z Fold's inner screen is 835x752 CSS px unfolded and landscape (752x835
 * upright) — both a hair ABOVE the 820px breakpoint this file used to carry,
 * so the unfolded phone silently got the desktop layout: mouse-sized targets,
 * and every card control parked behind a :hover that a finger never fires.
 * These lock the parts that are easy to undo by accident.
 */
describe("the layout survives a folding phone", () => {
  /** The media queries, each with the block it guards. */
  function mediaBlocks(): { query: string; body: string }[] {
    const out: { query: string; body: string }[] = [];
    const re = /@media([^{]+)\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(styles))) {
      // Walk the braces so a nested rule cannot end the block early.
      let depth = 1;
      let i = re.lastIndex;
      while (i < styles.length && depth > 0) {
        if (styles[i] === "{") depth++;
        else if (styles[i] === "}") depth--;
        i++;
      }
      out.push({ query: m[1].trim(), body: styles.slice(re.lastIndex, i - 1) });
    }
    return out;
  }

  const blocks = mediaBlocks();
  const stacking = blocks.filter((b) => /flex-direction:\s*column/.test(b.body) && /\.layout/.test(b.body));

  it("only stacks the rail below the unfolded width, never at it", () => {
    expect(stacking.length).toBeGreaterThan(0);
    for (const b of stacking) {
      const cap = /max-width:\s*(\d+)px/.exec(b.query);
      expect(cap, `stacking block has no max-width: ${b.query}`).toBeTruthy();
      // 752 is the NARROW side of the unfolded screen — upright. Stacking must
      // begin below it, or the fold loses its second column in one rotation.
      expect(Number(cap![1])).toBeLessThan(752);
    }
  });

  it("keeps the rail's own width from eating a small screen", () => {
    // The resizer writes --sidebar-w INLINE, which outranks any width here, so
    // the cap has to come through min() rather than a plain declaration.
    const narrow = blocks.find((b) => /max-width:\s*10\d\dpx/.test(b.query) && /\.sidebar/.test(b.body));
    expect(narrow).toBeTruthy();
    expect(narrow!.body).toMatch(/width:\s*min\(var\(--sidebar-w\)/);
  });

  it("brings every hover-revealed control out on touch", () => {
    const touch = blocks.filter((b) => /hover:\s*none/.test(b.query));
    expect(touch.length).toBeGreaterThan(0);
    const body = touch.map((b) => b.body).join("\n");
    // Each of these is a control the desktop hides until :hover — on a finger
    // that event never arrives, so hidden means gone.
    for (const sel of [".agent-actions", ".chat-turn-actions", ".chat-edit-btn", ".copy-btn", ".group-rename"]) {
      expect(body, `${sel} stays hover-only on touch`).toContain(sel);
    }
    expect(body).toMatch(/opacity:\s*1/);
  });

  it("drops the button that acts on a screen you are not sitting at", () => {
    const touch = blocks.filter((b) => /hover:\s*none/.test(b.query)).map((b) => b.body).join("\n");
    // "window" pops a Windows terminal on the HUB's machine; "wake" revives a
    // sleeping agent, which is the reason to open this from a phone at all.
    expect(touch).toMatch(/\.open-btn\s*\{\s*display:\s*none/);
    expect(touch).not.toMatch(/\.reopen-btn[^{]*\{[^}]*display:\s*none/);
  });

  it("reserves room for the cluster it just made permanent", () => {
    const touch = blocks.filter((b) => /hover:\s*none/.test(b.query)).map((b) => b.body).join("\n");
    // Measured: cluster 100px at 10px from the edge, against a 70px reserve —
    // the name ran under the buttons and its ellipsis lied about where it ended.
    const pad = /\.agent-name-row\s*\{\s*padding-right:\s*(\d+)px/.exec(touch);
    expect(pad).toBeTruthy();
    expect(Number(pad![1])).toBeGreaterThanOrEqual(110);
  });

  it("does not let the rigid usage card crush the agent list", () => {
    // usage-card is flex: 0 0 auto and ~350px tall. In a rail capped to a
    // fraction of a phone screen it would win outright: the list goes to zero
    // and the card spills over the conversation. It is NOT hidden (that lost
    // real info the owner wanted) — it starts collapsed to one line instead,
    // decided in loadUsageCollapsed, and the sidebar clips as a backstop.
    const stackedBody = stacking.map((b) => b.body).join("\n");
    expect(stackedBody).toMatch(/\.sidebar\s*\{[^}]*overflow:\s*hidden/);
    // The collapse default for narrow screens lives in the script.
    expect(script).toMatch(/matchMedia\("\(max-width: 1080px\)"\)/);
    expect(script).toMatch(/stored !== null \? stored : narrow/);
  });

  it("measures phone-sized panels against the visible viewport", () => {
    // vh still reports the whole screen with a keyboard open; dvh does not.
    expect(styles).toMatch(/height:\s*100dvh/);
    const stackedBody = stacking.map((b) => b.body).join("\n");
    expect(stackedBody).toMatch(/max-height:\s*\d+dvh/);
  });

  it("lets a virtual keyboard resize the page instead of covering it", () => {
    expect(html).toMatch(/interactive-widget=resizes-content/);
  });

  it("keeps the transcript header to one swipeable line when narrow", () => {
    const narrow = blocks.find((b) => /max-width:\s*10\d\dpx/.test(b.query) && /\.feed-head/.test(b.body));
    expect(narrow).toBeTruthy();
    // The strip scrolls sideways; the chips inside it must not break mid-label.
    expect(narrow!.body).toMatch(/overflow-x:\s*auto/);
    expect(narrow!.body).toMatch(/white-space:\s*nowrap/);
  });
});

/**
 * The sign-out button exists for exactly one situation: a board reached
 * through a tunnel, where the session cookie is otherwise good for its full
 * term and there is no other way to end it. On a local hub there is no session
 * at all, so the button must not sit there promising one.
 */
describe("signing out of a remote session", () => {
  it("ships hidden, and is revealed only after asking the hub", () => {
    expect(html).toMatch(/id="signout"[^>]*hidden/);
    // Revealed from the auth status, never from a guess about the URL.
    expect(script).toContain("/api/auth/status");
    expect(script).toMatch(/enabled\s*===\s*true/);
  });

  it("ends the session on the hub, not just in the tab", () => {
    // Dropping the cookie locally would leave the session valid on the server;
    // the point is to invalidate it there.
    expect(script).toMatch(/"\/api\/auth\/logout"[\s\S]{0,120}method:\s*"POST"/);
  });
});

/**
 * The "/" menu used to be a literal: fourteen Claude Code built-ins typed into
 * an object. An operator with seventy-odd skills of their own typed "/" and
 * saw none of them — nothing here had ever looked for them.
 */
describe("the slash menu offers the agent's own skills", () => {
  it("asks the hub instead of trusting a hard-coded list", () => {
    expect(script).toMatch(/\/api\/agents\/\$\{encodeURIComponent\(name\)\}\/skills/);
    // Per agent, because the project scope depends on its cwd.
    expect(script).toContain("loadSkills");
  });

  it("merges skills with the built-ins, letting a skill win the name", () => {
    expect(script).toContain("function slashSource");
    // A skill named like a built-in is what the agent will actually run, so
    // offering the built-in's description for it would be a lie.
    expect(script).toMatch(/taken\.has\(cmd\)/);
  });

  it("does not let a stale response overwrite a newer screen", () => {
    // Two tabs opened quickly: the first fetch can land after the second.
    expect(script).toMatch(/if \(skillState\.name !== name\) return;/);
  });

  it("ranks the project's own skills above the seventy others", () => {
    expect(script).toMatch(/scope === "project" \? 0/);
  });
});

/**
 * Showing what the agent saw, and what it handed over.
 */
describe("images and files in the chat", () => {
  it("fetches each image instead of inlining it", () => {
    // Inlining is the obvious implementation and the wrong one: these are
    // ~200 KB of base64 each and one conversation here holds 315.
    expect(script).toMatch(/transcript\/image/);
    expect(script).toMatch(/loading = "lazy"/);
  });

  it("keeps a card with pictures out of the folded 'N actions' group", () => {
    // Runs of tool cards fold into a collapsed group, and collapsed means
    // display:none — which hides the picture AND stops the lazy <img> from
    // ever loading. Found only by rendering it (04/09).
    expect(script).toMatch(/dataset\.hasShots = "1"/);
    expect(script).toMatch(/if \(node\.dataset\.hasShots\)/);
  });

  it("offers a download that a phone can actually use", () => {
    // "folder" opens Explorer on the HUB's machine — useless from a phone.
    expect(script).toMatch(/download=1/);
    // It must be a navigation, or Content-Disposition is never honoured.
    expect(script).toMatch(/a\.download = ""/);
  });
});

/**
 * Switching model from a phone.
 *
 * "/model" with no argument opens Claude Code's own picker INSIDE the TUI,
 * which needs arrow keys and Enter — so on a phone keyboard the model was
 * simply unchangeable (owner, 04/09: "quando digito barra model ele vai pro
 * terminal e não consigo selecionar no teclado do celular").
 */
describe("the model pill switches the model", () => {
  it("sends an argument, which is what skips the interactive picker", () => {
    // Verified against a live agent: "/model sonnet" answers "Set model to
    // Sonnet 5" with no picker at all.
    expect(script).toMatch(/`\/model \$\{alias\}`/);
    expect(script).toContain("openModelMenu");
  });

  it("uses aliases for the families that track latest", () => {
    // `opus`/`sonnet`/`haiku` track the newest of each, which is what you
    // want; a dated id like `claude-opus-4-1-20250805` would expire.
    expect(script).toMatch(/alias: "opus"/);
    expect(script).toMatch(/alias: "sonnet"/);
    expect(script).toMatch(/alias: "haiku"/);
    // "default" is the way BACK from a session pinned to the wrong model.
    expect(script).toMatch(/alias: "default"/);
  });

  it("pins fable to 5.1, because the bare alias drifts", () => {
    // The owner asked for 5.1 and "/model fable" gave him Fable 5 on an old
    // session while a fresh agent got 5.1 from the same command — the alias
    // is not stable across Claude Code versions. `claude-fable-5-1` is
    // (verified against a live agent, 04/09).
    expect(script).toMatch(/alias: "claude-fable-5-1"/);
    expect(script).toMatch(/label: "fable 5\.1"/);
  });

  it("says that the choice leaks into new sessions", () => {
    // Claude Code saves it as the default too, which is not what "switch this
    // chat" sounds like.
    expect(script).toContain("also becomes the default for new sessions");
  });

  it("keeps an escape hatch for a model the list does not know", () => {
    expect(script).toMatch(/"other…"/);
  });

  it("is a finger-sized target on touch", () => {
    const touch = (styles.match(/@media \(pointer: coarse\)[\s\S]*?\n    \}/) || [""])[0];
    expect(touch).toContain(".status-pill-btn");
  });
});

/**
 * Attaching a file from a phone.
 *
 * The composer could only take a file by drag or paste — neither of which
 * exists on a phone — so there was no way to send a photo from one (owner,
 * 04/09). A paperclip button drives a native <input type=file>, whose picked
 * files go through the SAME attachFiles path a drop uses.
 */
describe("the composer can attach a file", () => {
  it("has a paperclip and a native file input", () => {
    expect(html).toMatch(/id="chat-attach"/);
    // The <input> tag, whatever order its attributes fall in.
    const tag = (html.match(/<input[^>]*id="chat-file"[^>]*>/) || [""])[0];
    expect(tag).toContain('type="file"');
    // multiple, so a batch of photos is one trip.
    expect(tag).toContain("multiple");
  });

  it("routes picked files through the same path as a drop", () => {
    // Not a second, divergent upload path — the drop already resolves origins,
    // stages small files and references big ones.
    expect(script).toMatch(/attachBtn\.addEventListener\("click", \(\) => fileInput\.click\(\)\)/);
    expect(script).toMatch(/fileInput\.files.*attachFiles\(fileInput\.files\)/s);
  });

  it("resets the input so the same file can be picked twice", () => {
    // Picking the same file again fires no "change", and the attach would
    // silently do nothing.
    expect(script).toMatch(/fileInput\.value = ""/);
  });
});

/**
 * The agent-screen header cannot push the page into horizontal scroll.
 *
 * On the unfolded-portrait Fold (752px) with the Terminal view and the ENGINE
 * toggle showing, the header row summed past the panel: "open window" landed
 * 82px off the right edge, the whole page gained horizontal scroll, and the
 * hint string was crushed into a one-word-wide vertical sliver down the right
 * margin (owner's screenshot, 08/09).
 */
describe("the agent-screen header fits a phone", () => {
  function mediaBlocks(): { query: string; body: string }[] {
    const out: { query: string; body: string }[] = [];
    const re = /@media([^{]+)\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(styles))) {
      let depth = 1;
      let i = re.lastIndex;
      while (i < styles.length && depth > 0) {
        if (styles[i] === "{") depth++;
        else if (styles[i] === "}") depth--;
        i++;
      }
      out.push({ query: m[1].trim(), body: styles.slice(re.lastIndex, i - 1) });
    }
    return out;
  }
  const blocks = mediaBlocks();

  it("lets the header wrap and drops the hint on narrow screens", () => {
    const narrow = blocks.filter((b) => /max-width:\s*1080px/.test(b.query)).map((b) => b.body).join("\n");
    expect(narrow).toMatch(/\.screen-head\s*\{[^}]*flex-wrap:\s*wrap/);
    // The hint is the sliver — gone on a touchscreen, where its keyboard tip
    // means nothing anyway.
    expect(narrow).toMatch(/\.screen-hint\s*\{\s*display:\s*none/);
  });

  it("drops 'open window' on touch, like the card's twin", () => {
    const touch = blocks.filter((b) => /hover:\s*none/.test(b.query)).map((b) => b.body).join("\n");
    // It opens a Windows terminal on the host — a window nobody is near.
    expect(touch).toMatch(/#screen-window\s*\{\s*display:\s*none/);
  });
});

/**
 * Closing the rail and opening it again.
 *
 * On a phone the two columns split a narrow screen; the owner asked to be able
 * to close the agent rail and reopen it on demand. A full hide, distinct from
 * the desktop resizer, with the state remembered.
 */
describe("the rail can be closed and reopened", () => {
  it("has a toggle button and a collapsed state on <html>", () => {
    expect(html).toMatch(/id="rail-toggle"/);
    expect(styles).toMatch(/html\.rail-collapsed \.sidebar\s*\{\s*display:\s*none/);
  });

  it("remembers the choice and refits the terminal to the new width", () => {
    expect(script).toContain("setupRailToggle");
    expect(script).toMatch(/"sb\.railCollapsed"/);
    // Closing the rail widens the panel; the xterm grid must follow.
    expect(script).toMatch(/if \(screenState\.fit\) scheduleScreenFit\(\)/);
  });
});

/**
 * From the comparison with the cousin's app (23/09): the composer bugs that
 * the side-by-side exposed.
 */
describe("the composer, per agent and safe to paste into", () => {
  it("only reads pasted text as paths when EVERY line is a path", () => {
    // A log with one /home/… line in it used to become that one attachment,
    // and the rest of the paste was thrown away.
    const src = script.match(/function pathsFromTransfer[\s\S]*?\n      }/)?.[0] ?? "";
    expect(src).toMatch(/lines\.every\(\(l\) => localFileTarget\(l\)\)/);
  });

  it("keeps one draft per agent, attachments included, and drops it on send", () => {
    expect(script).toContain('const DRAFTS_KEY = "sb.drafts"');
    // The token→path map travels with the text, or a restored token is sent
    // literally with no path behind it.
    expect(script).toMatch(/att: \[\.\.\.attachments\]/);
    // openScreen swaps the composer to the opened agent's own draft.
    const open = script.match(/function openScreen\(name\)[\s\S]*?\n    }/)?.[0] ?? "";
    expect(open).toContain("draftHooks.restore(name)");
    expect(script).toContain("draftHooks.clear(name)");
  });

  it("keeps ↑ history per agent and across reloads", () => {
    expect(script).toContain('const HISTORY_KEY = "sb.sentHistory"');
    expect(script).toMatch(/historyByAgent\[name\] = list\.slice\(-30\)/);
  });

  it("never acts on keys from a keyboard still composing a word", () => {
    // Gboard / voice typing report their keys mid-composition; that Enter
    // sent half a word.
    expect(script).toContain("if (ev.isComposing || ev.keyCode === 229) return;");
  });

  it("quotes an attachment path that contains whitespace", () => {
    expect(script).toMatch(/join\(\/\\s\/\.test\(p\) \? `"\$\{p\}"` : p\)/);
  });

  it("names a dropped folder instead of failing on it", () => {
    expect(script).toContain("Folders can't be attached");
  });
});

/**
 * Phone polish ported from the cousin's app (23/09): installable, notifying,
 * cheaper on long chats, with a way back to the newest message.
 */
describe("the board as a phone app", () => {
  const publicDir = path.join(process.cwd(), "public");

  it("links a manifest with standalone display and a maskable icon", () => {
    expect(html).toMatch(/<link rel="manifest" href="\/manifest\.webmanifest"/);
    const manifest = JSON.parse(fs.readFileSync(path.join(publicDir, "manifest.webmanifest"), "utf8"));
    expect(manifest.display).toBe("standalone");
    expect(manifest.icons.some((i: { purpose?: string }) => i.purpose === "maskable")).toBe(true);
    for (const icon of manifest.icons) {
      expect(fs.existsSync(path.join(publicDir, icon.src.replace(/^\//, "")))).toBe(true);
    }
  });

  it("ships a service worker that caches nothing", () => {
    const sw = fs.readFileSync(path.join(publicDir, "sw.js"), "utf8");
    // Live state behind a password must never be served from a cache.
    expect(sw).not.toMatch(/caches\.open|cache\.put|respondWith/);
    expect(sw).toContain("notificationclick");
  });

  it("notifies through the service worker, never about the screen you watch", () => {
    // Android Chrome rejects a page's `new Notification()`.
    expect(script).toContain("swRegistration.showNotification(title, opts)");
    expect(script).toContain('if (!document.hidden && screenState.name === name) return;');
    // One per agent: the tag replaces instead of stacking.
    expect(script).toMatch(/tag: `sb-agent-\$\{name\}`/);
  });

  it("skips layout for off-screen turns but keeps their height", () => {
    expect(styles).toMatch(/content-visibility: auto;\s*contain-intrinsic-size: auto 140px;/);
  });

  it("jumps to the real bottom, not a smooth scroll that the growing thread outruns", () => {
    const fn = script.match(/function setupChatJump[\s\S]*?\n    }/)?.[0] ?? "";
    expect(fn).toContain("requestAnimationFrame(settle)");
    expect(fn).not.toContain('behavior: "smooth"');
  });

  it("offers /compact from the context pill, behind a confirmation", () => {
    expect(script).toMatch(/showConfirmDialog\(\s*`Compact \$\{displayOf\(agent\.name\)\}'s context\?`/);
    expect(script).toContain('sendChatMessage(agent.name, "/compact")');
  });

  it("labels a Codex window that has no duration", () => {
    const label = embeddedFunction<(m: unknown) => string>("usageWindowLabel");
    expect(label(null)).toBe("window");
    expect(label(300)).toBe("5h window");
  });
});

/**
 * UI pass after the owner's screenshot of the composer (23/09): buttons that
 * grew with the text, a paperclip smaller than its neighbours, and the rest of
 * what the same look at every screen turned up.
 */
describe("the UI pass", () => {
  it("gives every composer control one fixed height, bottom-aligned", () => {
    const rule = styles.match(/\.chat-composer-row > \.btn \{[\s\S]*?\}/)?.[0] ?? "";
    expect(rule).toContain("height: 38px");
    expect(rule).toContain("align-self: flex-end");
    // Stretching is what made them grow with each line of text.
    expect(styles).not.toMatch(/\.chat-(send|stop|mic) \{[^}]*align-self: stretch/);
    // And the shared rule must not set display, or it pins the stop button on
    // (its own comment explains that, so comments are stripped first).
    expect(rule.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/display:/);
  });

  it("floats the agent menu over the page and puts it back on close", () => {
    expect(script).toContain("function floatMenu(menu, anchor, home, point)");
    expect(script).toContain("document.body.appendChild(menu)");
    // Measured by layout, not by a rect taken mid entrance-animation.
    expect(script).toContain("{ width: menu.offsetWidth, height: menu.offsetHeight }");
    expect(script).toContain("m.__home.appendChild(m)");
    expect(styles).toMatch(/\.agent-menu\.floating \{[^}]*position: fixed/);
  });

  it("closes an open menu on a tap anywhere, even where clicks stop bubbling", () => {
    expect(script).toMatch(/"pointerdown",[\s\S]{0,300}closeMenus\(\);[\s\S]{0,40}true,/);
  });

  it("gives every menu row the same type, whatever hook class it carries", () => {
    const rule = styles.match(/\.agent-menu \.agent-menu-item \{[\s\S]*?\}/)?.[0] ?? "";
    expect(rule).toContain("font-family: var(--sans)");
    expect(rule).toContain("font-size: var(--fs-md)");
  });

  it("keeps group tabs on one swipeable line at every width", () => {
    const rule = styles.match(/\n    \.group-tabs \{[\s\S]*?\}/)?.[0] ?? "";
    expect(rule).toContain("flex-wrap: nowrap");
    expect(rule).toContain("overflow-x: auto");
  });

  it("gives the conversation the folded screen when an agent is open", () => {
    // The stacked rail left ~110px of chat on a 412px phone.
    expect(styles).toMatch(/html\.screen-open:not\(\.rail-peek\) \.sidebar \{ display: none; \}/);
    expect(script).toContain('root.classList.toggle("rail-peek")');
  });

  it("drops keyboard hints and the drag hint on a touch screen", () => {
    expect(styles).toMatch(/@media \(hover: none\) \{[\s\S]{0,300}\.composer-keys \{ display: none; \}/);
    expect(script).toContain('window.matchMedia("(hover: hover)").matches');
  });

  it("says 'refreshing' instead of 'retry in now'", () => {
    expect(script).toContain('wait === "now" ? "refreshing…"');
  });
});

/**
 * The dashboard's faces come from the JavaScript engine (public/faces/faces.js),
 * tuned first in /faces-lab.html and applied on the owner's "go" (29/09).
 */
describe("the rail wears the faces engine", () => {
  it("a poke answers the click without stealing it from the card", () => {
    const at = script.indexOf("portrait.addEventListener");
    expect(at).toBeGreaterThan(-1);
    const handler = script.slice(at, at + 400);
    expect(handler).toContain('react("poke")');
    expect(handler).not.toContain("stopPropagation"); // the card still opens
    expect(handler).not.toContain("preventDefault");
  });

  it("loads the engine and keeps one live face per agent across rebuilds", () => {
    expect(script).toContain('import("/faces/faces.js")');
    expect(script).toContain("const faceHosts = new Map()");
    // The card gets the persisted host, not a fresh node each poll.
    expect(script).toContain("portrait.appendChild(agentFaceHost(agent, blobState))");
  });

  it("colours the body with the agent's own pick, never the state", () => {
    const fn = script.match(/function agentFaceHost[\s\S]*?\n    }/)?.[0] ?? "";
    expect(fn).toContain("chatColor(agent.name) || Faces.DEFAULT_COLOR");
    // A colour picked in the ⋯ menu lands on the face at once.
    expect(script).toMatch(/entry\.face\.setColor\(color \|\| Faces\.DEFAULT_COLOR\)/);
  });

  it("turns state changes into reactions", () => {
    const fn = script.match(/function faceReactionFor[\s\S]*?\n    }/)?.[0] ?? "";
    expect(fn).toContain('return "cheer"');
    expect(fn).toContain('if (to === "asking") return "perk"');
  });

  it("follows the dashboard's own reduced-motion override", () => {
    expect(script).toContain("Faces.forceMotion(");
  });
});

describe("the floating menu sits under what it opens", () => {
  // At z-index 200 the colour picker (70) opened BENEATH the ⋯ menu, so a
  // tapped colour landed on the menu and was never picked (29/09).
  const z = (sel: string) => Number(styles.match(new RegExp(sel.replace(/[.]/g, "\\.") + " \\{[^}]*?z-index: (\\d+)"))?.[1]);
  it("is above every card and below the picker, dialogs and lightbox", () => {
    const menu = z(".agent-menu.floating");
    expect(menu).toBeGreaterThan(z(".agent-card.menu-open"));
    for (const over of [".color-pop", ".palette-backdrop", ".lightbox"]) {
      expect(menu, over).toBeLessThan(z(over));
    }
  });
});

/**
 * Subgroups — an agency's clients (owner, 30/09). The wall rule itself is
 * tested on the hub (test/subgroups.test.ts); these pin the board's side.
 */
describe("subgroups on the board", () => {
  it("mirrors the hub's wall rule", () => {
    const touch = embeddedFunctionWith<(a: string, b: string) => boolean>("groupsTouch", ["parentOfGroup"]);
    expect(touch("agency", "agency/acme")).toBe(true);
    expect(touch("agency/acme", "agency/globex")).toBe(false);
  });

  it("files a conversation across agency/client in the client's room", () => {
    const fn = script.match(/function messageGroup\(m\) \{[\s\S]*?\n    }/)?.[0] ?? "";
    expect(fn).toContain("return parentOfGroup(a) ? a : b");
  });

  it("lets a parent's tab read its whole family", () => {
    expect(script).toContain("if (state.group && !inGroupFamily(messageGroup(m), state.group)) continue;");
  });

  it("draws each client inside its agency's box", () => {
    expect(script).toContain('const box = el("div", sub ? "rail-group rail-subgroup" : "rail-group")');
    expect(styles).toMatch(/\.rail-subgroup \{/);
  });

  it("accepts one '/' in a typed group name, and only one", () => {
    const clean = embeddedFunctionWith<(raw: string, keep: boolean) => string>("sanitizeGroupNameInput", ["sanitizeAgentNameInput"]);
    expect(clean("AI Panorama/Acme Corp", false)).toBe("ai-panorama/acme-corp");
    expect(clean("agency/a/b", false)).toBe("agency/a-b");
    expect(clean("agency/", true)).toBe("agency/");
    expect(clean("agency/", false)).toBe("agency");
  });

  it("offers a '+ client' on every agency in the groups panel", () => {
    expect(script).toContain('"+ client"');
  });
});

describe("the agent menu (⋯ or right-click)", () => {
  // Sixteen rows in one flat list, emoji that did not all render, the
  // everyday next to the once-a-year (owner, 30/09: "ta super ruim a
  // usabilidade dali"). Rebuilt with sections and two inner pages.
  const menu = embeddedFunctionSource("buildAgentMenu");
  const mainPage = menu.slice(0, menu.indexOf('const groupPage = subPage("Move to group")'));

  it("opens on a right-click at the pointer, leaving shift + right-click to the browser", () => {
    expect(script).toContain('card.addEventListener("contextmenu"');
    expect(script).toContain("if (ev.shiftKey ||");
    expect(script).toContain("openAgentMenu(menu, card, kebab, menuWrap, fromKeyboard ? null : { x: ev.clientX, y: ev.clientY })");
    // Placed at the point, flipped left/up when that side runs out of screen.
    expect(embeddedFunctionSource("floatMenu")).toContain("point.x + mr.width <= vw - pad ? point.x : point.x - mr.width");
  });

  it("draws its icons instead of spelling them in emoji", () => {
    expect(script).not.toContain("MENU_ICONS = {");
    for (const emoji of ["⏻", "📣", "🗑", "🚪", "🛠", "👑"]) expect(menu, emoji).not.toContain(emoji);
    expect(styles).toMatch(/\.agent-menu \.mi-icon svg \{[^}]*stroke: currentColor/);
  });

  it("keeps the first page short and the technical rows one step in", () => {
    const rows = [...mainPage.matchAll(/main\.appendChild\(\s*agentMenuRow\(/g)].length;
    expect(rows).toBeLessThanOrEqual(13);
    const more = menu.slice(menu.indexOf('const morePage = subPage("More")'));
    for (const cls of ["bootcmd-btn", "cliargs-btn", "rename-btn", "mute-toggle", "autostart-btn", "leader-btn", "nudge-btn"]) {
      expect(mainPage, cls).not.toContain(`cls: "${cls}"`);
      expect(more, cls).toContain(`cls: "${cls}"`);
    }
  });

  it("puts its inner pages IN the menu (they were built and never shown)", () => {
    const sub = menu.slice(menu.indexOf("const subPage = (title) =>"), menu.indexOf("const sep = (page) =>"));
    expect(sub).toContain("menu.appendChild(page)");
  });

  it("moves an agent into a new client of an agency, right from the menu", () => {
    expect(menu).toContain('newGroupRow("client", "New client…"');
    expect(menu).toContain('const target = kind === "client" ? `${agency.value}/${typed}` : typed;');
    expect(menu).toContain("moveAgentToGroup(agent.name, target)");
    // The rule that makes a subgroup worth having, said where you pick one.
    expect(menu).toContain("A client talks to its agency — never to another client.");
  });

  it("asks before removing or starting blank", () => {
    expect(menu).toContain('if (!armMenuRow(item, isChild ? "Kill? Click again" : "Remove? Click again")) return;');
    expect(menu).toContain('if (!armMenuRow(item, "Start blank? Click again")) return;');
  });

  it("redraws the rail once it closes, so a switch flipped inside shows on the card", () => {
    expect(embeddedFunctionSource("closeMenus")).toContain("if (wasOpen) queueMicrotask(renderAgents)");
  });
});

describe("groups made ahead of their agents (rail)", () => {
  // Owner, 01/10: "quero poder criar um subgrupo antes de por um agente.
  // deixa as coisas mais simples". Groups live on the hub now, not as page
  // drafts that vanished when the panel closed.
  it("creates groups on the hub — no page-only drafts left", () => {
    expect(script).not.toContain("draftGroups");
    expect(embeddedFunctionSource("createGroup")).toContain('fetch("/api/groups"');
    expect(embeddedFunctionSource("allGroups")).toContain("for (const g of state.groups) present.add(g)");
  });

  it("puts '+ client' on every agency's head, naming it right in the rail", () => {
    const head = embeddedFunctionSource("buildGroupHead");
    expect(head).toContain('el("span", "group-addsub", "+ client")');
    expect(head).toContain("startNewGroupInline(group)");
    // The field freezes the rail's rebuilds while typing, like every rename.
    expect(embeddedFunctionSource("startNewGroupInline")).toContain('"agent-rename-input rail-new-input"');
  });

  it("makes '+ group' name the group in place instead of opening a panel", () => {
    expect(script).toMatch(/\$\("#groups-open"\)\.addEventListener\("click", \(ev\) => \{[\s\S]{0,80}startNewGroupInline\(null\)/);
  });

  it("tells an empty group how to fill it, and lets it be deleted", () => {
    const hint = embeddedFunctionSource("buildEmptyGroupHint");
    expect(hint).toContain("openLauncherInGroup(group)");
    expect(hint).toContain("deleteGroup(group)");
    expect(embeddedFunctionSource("deleteGroup")).toContain("method: \"DELETE\"");
  });

  it("never keeps an empty 'Desagrupados' around", () => {
    expect(embeddedFunctionSource("setKnownGroups")).toContain("g !== DEFAULT_GROUP");
  });

  it("redraws when the groups change with nobody moving", () => {
    expect(embeddedFunctionSource("railSignature")).toContain("allGroups().join(\",\")");
    expect(script).toContain('case "groups_updated":');
  });
});

describe("the launcher's New folder mode", () => {
  it("joins where it goes with the typed name and asks the hub to create it", () => {
    expect(html).toContain('id="launch-dirmode-new" value="new"');
    expect(embeddedFunctionSource("newFolderPath")).toContain("`${parent}/${leaf}`");
    const launch = embeddedFunctionSource("launchAgent");
    expect(launch).toContain("if (createDir) payload.createDir = true;");
    expect(launch).toContain("continue: createDir ? false :"); // nothing to continue in a new folder
  });

  it("strips what no folder name may hold, and shows the path before creating it", () => {
    const clean = embeddedFunctionWith<(raw: string) => string>("cleanFolderName", []);
    expect(clean('Acme: "Site"/v2 ')).toBe("Acme Sitev2");
    expect(clean("..hidden")).toBe("hidden");
    expect(embeddedFunctionSource("renderNewFolderPreview")).toContain('preview.append("Creates "');
  });

  it("remembers where the last new folder went", () => {
    expect(script).toContain('localStorage.setItem(NEW_FOLDER_PARENT_KEY, $("#launch-dir").value.trim())');
  });
});

describe("the recent dock", () => {
  // Owner, 04/10: two agents in use, one at the top of the rail and one at
  // the bottom. A column of the agents opened lately, as faces, one click away.
  const next = embeddedFunctionWith<
    (list: Array<{ name: string; at: number }>, name: string, now: number, max: number, rise?: boolean) => Array<{ name: string; at: number }>
  >("nextRecent", []);

  it("sits at the far left, before the rail", () => {
    expect(html.indexOf('id="recent-dock"')).toBeLessThan(html.indexOf('<aside class="sidebar">'));
    expect(embeddedFunctionSource("openScreen")).toContain("noteRecent(name)");
  });

  it("puts a new agent on top", () => {
    const out = next([{ name: "a", at: 1 }], "b", 2, 9);
    expect(out.map((e) => e.name)).toEqual(["b", "a"]);
  });

  it("keeps an agent's place when you go back to it", () => {
    const list = [{ name: "b", at: 2 }, { name: "a", at: 1 }];
    expect(next(list, "a", 3, 9).map((e) => e.name)).toEqual(["b", "a"]);
    expect(next(list, "a", 3, 9)[1].at).toBe(3);
  });

  it("when full, lets go of the one opened longest ago — not the oldest arrival", () => {
    // "c" came in first but was opened just now; "a" has been idle longest.
    const list = [{ name: "a", at: 5 }, { name: "b", at: 6 }, { name: "c", at: 9 }];
    const tweaked = [{ name: "b", at: 6 }, { name: "a", at: 2 }, { name: "c", at: 9 }];
    expect(next(tweaked, "d", 10, 3).map((e) => e.name)).toEqual(["d", "b", "c"]);
    expect(next(list, "d", 10, 3)).toHaveLength(3);
  });

  it("jumps with Alt+1…9 and back to the traffic with Alt+0", () => {
    expect(script).toContain("if (!/^Digit[0-9]$/.test(ev.code)) return;");
    expect(script).toContain("openScreen(target.name)");
  });

  it("can be hidden to a thin strip, remembered across reloads", () => {
    const render = embeddedFunctionSource("renderRecentDock");
    expect(render).toContain('dock.classList.toggle("collapsed", dockHidden)');
    expect(render).toContain("setDockHidden(false)");
    expect(render).toContain("setDockHidden(true)");
    expect(script).toContain('localStorage.setItem(DOCK_HIDDEN_KEY, hidden ? "1" : "0")');
    expect(styles).toMatch(/\.recent-dock\.collapsed \{[^}]*width: 14px/);
  });

  it("names every face — they share one colour until someone picks", () => {
    expect(embeddedFunctionSource("renderRecentDock")).toContain('el("span", "dock-name", displayOf(agent))');
  });

  it("steps aside on a phone", () => {
    expect(styles).toMatch(/@media \(max-width: 640px\) \{\s*\.recent-dock \{ display: none; \}/);
  });
});

describe("taking an agent out of the recent dock", () => {
  // Owner, 04/10: an "×" on hover that must be HELD 2s, so nothing goes by
  // accident — and no ⇄ button on top ("isso eu praticamente nunca uso").
  const x = embeddedFunctionSource("dockRemoveButton");

  it("has no agent-traffic button any more", () => {
    expect(embeddedFunctionSource("renderRecentDock")).not.toContain("dock-home");
  });

  it("removes only after a 2-second hold, never on a click", () => {
    expect(script).toContain("const DOCK_HOLD_MS = 2000;");
    expect(x).toContain("setTimeout(() => {");
    expect(x).toContain("forgetRecent(name)");
    // The release must not open the agent underneath.
    expect(x).toMatch(/addEventListener\("click", \(ev\) => \{\s*ev\.preventDefault\(\);\s*ev\.stopPropagation\(\);/);
  });

  it("cancels when you let go early or slide off", () => {
    expect(x).toContain('["pointerup", "pointercancel", "lostpointercapture"]');
    expect(x).toContain('addEventListener("pointermove"');
    expect(x).toContain("cancelDockHold()");
  });

  it("holds the dock still mid-hold — a rebuild would lose the release", () => {
    expect(embeddedFunctionSource("renderRecentDock")).toContain("if (!dock || dockHold) return;");
  });

  it("shows the hold filling up, and only on hover", () => {
    expect(styles).toMatch(/\.dock-remove\.holding \.dock-remove-ring \{[^}]*transition: stroke-dashoffset 2s linear/);
    expect(styles).toMatch(/\.dock-item:hover \.dock-remove \{ opacity: 1; pointer-events: auto; \}/);
  });
});

describe("an agent's family on the rail (children and its codex)", () => {
  // Owner, 05/10: a child "fica um boneco menor da mesma cor que ele em baixo
  // dele" — and the codex versions grouped the same way.
  it("draws an agent's codex sibling and children under it, as satellites", () => {
    const append = embeddedFunctionSource("appendAgentCards");
    expect(append).toContain("familyRootOf(agent)");
    expect(append).toContain('satCard.classList.add("satellite")');
    expect(append).toContain('satCard.prepend(el("span", "sat-link"))');
    const root = embeddedFunctionSource("familyRootOf");
    expect(root).toContain("agent.parent && state.agents.has(agent.parent)");
    expect(root).toContain("pair.codex.name === agent.name");
  });

  it("gives a satellite a smaller face, stepped in under its root", () => {
    expect(styles).toMatch(/\.agent-card\.satellite \.agent-portrait\.blob > \.sb-face-host \{ width: 40px; height: 40px;/);
    expect(styles).toMatch(/\.rail-group \.agent-card\.satellite \{ margin: 0 0 0 26px; \}/);
  });

  it("wears its root's colour and shape until given its own", () => {
    expect(embeddedFunctionSource("chatColor")).toContain('localStorage.getItem("sb.chatColor." + root.name)');
    expect(embeddedFunctionSource("blobShapeOf")).toContain("blobShapes.get(root.name)");
  });
});

describe("opening and killing a child", () => {
  const menu = embeddedFunctionSource("buildAgentMenu");

  it("offers New child on a Claude agent, never on a child", () => {
    expect(menu).toContain('if (agentTypeOf(agent) === "claude" && !agent.parent && !agent.name.endsWith("-codex"))');
    expect(menu).toContain("createChild(agent.name, typed)");
  });

  it("keeps what was typed as the name shown, and makes an address out of it", () => {
    const create = embeddedFunctionSource("createChild");
    expect(create).toContain("sanitizeAgentNameInput(typed, false)");
    expect(create).toContain("if (typed && typed !== id) body.displayName = typed;");
    expect(create).toContain("/children`");
  });

  it("calls it Kill on a child, and always stops it before removing", () => {
    expect(menu).toContain('label: isChild ? "Kill" :');
    expect(menu).toContain("if (online || isChild) {");
  });

  it("opens a page with a field ON the field, so typing never presses a row", () => {
    expect(menu).toContain('page.querySelector("input, select") ||');
  });
});


describe("the recent dock follows the conversation", () => {
  // Owner, 05/10: "tem que mudar a ordem ... quando for o último que falei" and
  // "quando o bot manda msg e eu não vejo ele tem que ir pra cima".
  const next = embeddedFunctionWith<
    (list: Array<{ name: string; at: number }>, name: string, now: number, max: number, rise?: boolean) => Array<{ name: string; at: number }>
  >("nextRecent", []);
  const list = [{ name: "a", at: 3 }, { name: "b", at: 2 }, { name: "c", at: 1 }];

  it("a message moves the agent to the top, the rest step down in order", () => {
    expect(next(list, "c", 9, 9, true).map((e) => e.name)).toEqual(["c", "a", "b"]);
  });

  it("just opening one does not reshuffle the column", () => {
    expect(next(list, "c", 9, 9).map((e) => e.name)).toEqual(["a", "b", "c"]);
  });

  it("rises when you send it a message", () => {
    expect(embeddedFunctionSource("sendChatMessage")).toContain("noteRecent(name, true);");
  });

  it("rises when it answers while you look elsewhere — only if it is in the dock", () => {
    expect(script).toMatch(/markUnseen\(incoming\.name\);\s*riseInDock\(incoming\.name\);/);
    expect(embeddedFunctionSource("riseInDock")).toContain("if (recentAgents.some((e) => e.name === name))");
  });

  it("slides the faces to their new places instead of jumping", () => {
    const slide = embeddedFunctionSource("slideDockItems");
    expect(slide).toContain("translateY(${delta}px)");
    expect(slide).toContain("prefers-reduced-motion: reduce");
  });
});

describe("the faz-tudo on the board", () => {
  it("sits pinned above the rooms, and no room is made around it", () => {
    const render = embeddedFunctionSource("renderAgents");
    expect(render).toContain('const pinned = matching.filter((a) => a.everywhere);');
    expect(render).toContain('el("div", "rail-pinned")');
    expect(embeddedFunctionSource("allGroups")).toContain(".filter((a) => !a.everywhere)");
  });

  it("is offered once, made on first use, then opened", () => {
    expect(embeddedFunctionSource("renderAgents")).toContain("buildAssistantSetup()");
    const open = embeddedFunctionSource("openAssistant");
    expect(open).toContain('fetch("/api/assistant", { method: "POST" })');
    expect(open).toContain("openScreen(body.agent.name)");
  });

  it("has its own 'new session' button — two clicks, a fresh launch", () => {
    expect(html).toContain('id="screen-fresh"');
    expect(embeddedFunctionSource("renderScreenStatus")).toContain("fresh.hidden = !(open && open.everywhere);");
    expect(script).toMatch(/\$\("#screen-fresh"\)\.addEventListener[\s\S]{0,1400}reopenAgent\(agent, el\("button"\), true\)/);
  });

  it("is in the command palette", () => {
    expect(script).toContain('name: "Faz-tudo", desc: "your assistant — reaches every agent"');
  });
});

describe("relative paths in the chat open where the file really is", () => {
  it("asks the hub where a relative path is before opening it", () => {
    expect(embeddedFunctionSource("locateAgentPath")).toContain("/files/locate?path=");
    expect(embeddedFunctionSource("wireLocalPathLink")).toContain("const real = locate ? (await locate()) || filePath : filePath;");
    expect(script).toContain("isRelativePath(p) && who ? () => locateAgentPath(who, p) : null");
  });
});
