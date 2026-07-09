// Unit tests of the Phase 4 CLI helpers (PRD section 11 + task item 8):
// argument validation, --claude-args parsing, env/claude argv assembly (token
// never leaked), EXACT one-line kickoff text, TUI readiness poll (NOTES.md:
// a blind kickoff would type into the trust dialog), status table formatting
// with fake data, relative time, shell quoting of newSession arrays, and the
// logs tail/follow helpers. Pure/injectable pieces only — no hub, no real
// tmux, no ports (the real-world paths live in test/cli.integration.test.ts).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildAgentCommand,
  isTuiReady,
  kickoffText,
  parseClaudeArgs,
  runKickoffAgent,
  runStart,
  type KickoffTmux,
} from "../src/cli/start.js";
import { formatStatusTable, type StatusRow } from "../src/cli/status.js";
import { describeDelivery } from "../src/cli/send.js";
import { runLogs, tailLines } from "../src/cli/logs.js";
import { CliError, formatRelative } from "../src/cli/common.js";
import { serveHeaderLines } from "../src/cli/serve.js";
import { createTmux, quoteShellArg, type ExecFn } from "../src/server/tmux.js";
import type { Delivery } from "../src/shared/types.js";

// ---------------------------------------------------------------------------
// parseClaudeArgs — documented decision: simple quote-aware splitter, no lib.
// ---------------------------------------------------------------------------

describe("parseClaudeArgs", () => {
  it("undefined/vazio → []", () => {
    expect(parseClaudeArgs(undefined)).toEqual([]);
    expect(parseClaudeArgs("")).toEqual([]);
    expect(parseClaudeArgs("   ")).toEqual([]);
  });

  it("split simples por whitespace (espaços múltiplos colapsam)", () => {
    expect(parseClaudeArgs("--model opus")).toEqual(["--model", "opus"]);
    expect(parseClaudeArgs("  --model   opus  ")).toEqual(["--model", "opus"]);
  });

  it("aspas simples agrupam um token com espaços (aspas removidas)", () => {
    expect(parseClaudeArgs("--append-system-prompt 'foo bar baz'")).toEqual([
      "--append-system-prompt",
      "foo bar baz",
    ]);
  });

  it("aspas duplas agrupam um token com espaços (aspas removidas)", () => {
    expect(parseClaudeArgs('--append-system-prompt "foo bar"')).toEqual([
      "--append-system-prompt",
      "foo bar",
    ]);
  });

  it("aspas no meio do token e token vazio quoted", () => {
    expect(parseClaudeArgs("-c 'printenv; exec cat'")).toEqual([
      "-c",
      "printenv; exec cat",
    ]);
    expect(parseClaudeArgs("a''b ''")).toEqual(["ab", ""]);
  });

  it("aspas não fechadas → CliError clara (nunca adivinhar)", () => {
    expect(() => parseClaudeArgs("--x 'aberto")).toThrow(CliError);
    expect(() => parseClaudeArgs('--x "aberto')).toThrow(/não fechadas/);
  });
});

// ---------------------------------------------------------------------------
// buildAgentCommand — PRD 11 passo 4, argv como ARRAY.
// ---------------------------------------------------------------------------

describe("buildAgentCommand", () => {
  it("monta env NAME/TOKEN + claude (sem args extras)", () => {
    expect(buildAgentCommand({ name: "alpha", token: "tok123" })).toEqual([
      "env",
      "SWITCHBOARD_AGENT_NAME=alpha",
      "SWITCHBOARD_AGENT_TOKEN=tok123",
      "claude",
    ]);
  });

  it("anexa os claude-args parseados com semântica de argv (aspas preservam espaços)", () => {
    expect(
      buildAgentCommand({
        name: "beta",
        token: "t",
        claudeArgs: "--model opus --append-system-prompt 'a b'",
      }),
    ).toEqual([
      "env",
      "SWITCHBOARD_AGENT_NAME=beta",
      "SWITCHBOARD_AGENT_TOKEN=t",
      "claude",
      "--model",
      "opus",
      "--append-system-prompt",
      "a b",
    ]);
  });

  it("claudeBin injetável (testes usam sh/cat no lugar do claude real)", () => {
    expect(buildAgentCommand({ name: "g", token: "t", claudeBin: "cat" })).toEqual([
      "env",
      "SWITCHBOARD_AGENT_NAME=g",
      "SWITCHBOARD_AGENT_TOKEN=t",
      "cat",
    ]);
  });
});

// ---------------------------------------------------------------------------
// kickoffText — texto EXATO do PRD 11 passo 6, uma linha, sem token.
// ---------------------------------------------------------------------------

describe("kickoffText", () => {
  it("é EXATAMENTE o texto do PRD 11 passo 6", () => {
    expect(kickoffText("alpha")).toBe(
      `[switchboard] Você é o agente 'alpha' nesta rede local de agentes. ` +
        `Confirme chamando a tool join com agent_name="alpha". ` +
        `Depois continue seu trabalho normalmente; quando receber notificações [switchboard], use check_messages.`,
    );
  });

  it("é sempre UMA linha (P5)", () => {
    expect(kickoffText("beta")).not.toMatch(/[\r\n]/);
  });

  it("NUNCA contém o token (o agente lê do env)", () => {
    expect(kickoffText("gamma")).not.toMatch(/TOKEN/i);
  });
});

// ---------------------------------------------------------------------------
// isTuiReady — marcadores de readiness do NOTES.md (spike 0.3).
// ---------------------------------------------------------------------------

const TRUST_DIALOG_PANE = [
  "Quick safety check: Is this a project you created or one you trust?",
  "❯ 1. Yes, I trust this folder",
  "  2. No, exit",
].join("\n");

const READY_PANE = ["╭──────╮", "│ > ", "╰──────╯", "  ? for shortcuts"].join("\n");

describe("isTuiReady", () => {
  it("reconhece o marcador '? for shortcuts'", () => {
    expect(isTuiReady("bla\n? for shortcuts\n")).toBe(true);
  });

  it("reconhece o marcador do input box '│ >'", () => {
    expect(isTuiReady("╭──╮\n│ > \n╰──╯")).toBe(true);
  });

  it("reconhece o rodapé do bypass permissions mode (substitui '? for shortcuts')", () => {
    // Observado com claude 2.1.205 + --permission-mode bypassPermissions: o
    // rodapé perde "? for shortcuts". Sem este marcador o kickoff de um agente
    // em bypass (que a seção 9.5 diz estar "coberto") daria timeout.
    const bypassFooter = [
      "❯ ",
      "────────",
      "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents",
    ].join("\n");
    expect(isTuiReady(bypassFooter)).toBe(true);
  });

  it("reconhece outros permission-mode footers (accept edits / plan mode)", () => {
    expect(isTuiReady("❯ \n  accept edits on (shift+tab to cycle)")).toBe(true);
    expect(isTuiReady("❯ \n  plan mode on (shift+tab to cycle)")).toBe(true);
  });

  it("diálogo de confiança (claude 2.1.205) NÃO é ready — dígitos selecionam opções", () => {
    expect(isTuiReady(TRUST_DIALOG_PANE)).toBe(false);
  });

  it("pane vazio/ilegível não é ready (fail-closed)", () => {
    expect(isTuiReady("")).toBe(false);
    expect(isTuiReady("$ ")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runKickoffAgent — delay inicial + poll de readiness + nudge guardado.
// ---------------------------------------------------------------------------

interface FakeKickoffWorld {
  tmux: KickoffTmux;
  calls: string[]; // ordered method log
  nudges: Array<{ session: string; text: string; enterDelayMs: number }>;
  sleeps: number[];
  now(): number;
  sleep(ms: number): Promise<void>;
}

function makeKickoffWorld(input: {
  panes: string[]; // consumed one per capturePane; last repeats
  hasSession?: boolean;
  nudgeResult?: { sent: boolean; reason?: string };
}): FakeKickoffWorld {
  let t = 0;
  const panes = [...input.panes];
  const world: FakeKickoffWorld = {
    calls: [],
    nudges: [],
    sleeps: [],
    now: () => t,
    sleep: async (ms: number) => {
      world.sleeps.push(ms);
      t += ms;
    },
    tmux: {
      async hasSession() {
        world.calls.push("hasSession");
        return input.hasSession ?? true;
      },
      async capturePane() {
        world.calls.push("capturePane");
        return panes.length > 1 ? panes.shift()! : panes[0];
      },
      async nudgeSession(session, text, enterDelayMs) {
        world.calls.push("nudgeSession");
        world.nudges.push({ session, text, enterDelayMs });
        return input.nudgeResult ?? { sent: true };
      },
    },
  };
  return world;
}

// baseDir that does not exist → loadConfig returns pure defaults, silently.
const NO_CONFIG_DIR = path.join(os.tmpdir(), "switchboard-none-cli-test");

describe("runKickoffAgent", () => {
  it("espera o delay, NÃO digita durante o trust dialog e só nudga quando a TUI fica pronta", async () => {
    const world = makeKickoffWorld({
      panes: [TRUST_DIALOG_PANE, TRUST_DIALOG_PANE, READY_PANE],
    });
    const result = await runKickoffAgent({
      name: "alpha",
      session: "sb-alpha",
      baseDir: NO_CONFIG_DIR,
      tmux: world.tmux,
      sleep: world.sleep,
      now: world.now,
      delayMs: 8000,
      enterDelayMs: 500,
      readinessTimeoutMs: 60_000,
      readinessPollMs: 2000,
    });

    expect(result.sent).toBe(true);
    // Delay inicial ANTES de qualquer olhada no pane.
    expect(world.sleeps[0]).toBe(8000);
    // 3 capturas (2 trust dialog + 1 ready), nudge SÓ depois da última.
    expect(world.calls.filter((c) => c === "capturePane")).toHaveLength(3);
    expect(world.calls.indexOf("nudgeSession")).toBeGreaterThan(
      world.calls.lastIndexOf("capturePane"),
    );
    // Texto EXATO do PRD, via caminho de nudge com guarda, com o delay do Enter.
    expect(world.nudges).toEqual([
      { session: "sb-alpha", text: kickoffText("alpha"), enterDelayMs: 500 },
    ]);
  });

  it("TUI nunca fica pronta → desiste após o budget SEM nudgar (kickoff cego proibido)", async () => {
    const world = makeKickoffWorld({ panes: [TRUST_DIALOG_PANE] });
    const result = await runKickoffAgent({
      name: "alpha",
      session: "sb-alpha",
      baseDir: NO_CONFIG_DIR,
      tmux: world.tmux,
      sleep: world.sleep,
      now: world.now,
      delayMs: 8000,
      readinessTimeoutMs: 10_000,
      readinessPollMs: 2000,
    });

    expect(result.sent).toBe(false);
    expect(result.reason).toMatch(/não ficou pronta/);
    expect(world.nudges).toHaveLength(0);
  });

  it("sessão morta → cancela sem nudgar", async () => {
    const world = makeKickoffWorld({ panes: [READY_PANE], hasSession: false });
    const result = await runKickoffAgent({
      name: "alpha",
      session: "sb-alpha",
      baseDir: NO_CONFIG_DIR,
      tmux: world.tmux,
      sleep: world.sleep,
      now: world.now,
      delayMs: 0,
    });

    expect(result.sent).toBe(false);
    expect(result.reason).toMatch(/não existe mais/);
    expect(world.nudges).toHaveLength(0);
  });

  it("abort da guarda de pane propaga (sent:false com o motivo)", async () => {
    const world = makeKickoffWorld({
      panes: [READY_PANE],
      nudgeResult: { sent: false, reason: "pane fora da allow-list" },
    });
    const result = await runKickoffAgent({
      name: "alpha",
      session: "sb-alpha",
      baseDir: NO_CONFIG_DIR,
      tmux: world.tmux,
      sleep: world.sleep,
      now: world.now,
      delayMs: 0,
    });

    expect(result.sent).toBe(false);
    expect(result.reason).toBe("pane fora da allow-list");
  });
});

// ---------------------------------------------------------------------------
// quoteShellArg + newSession com argv em ARRAY (tmux.ts).
// ---------------------------------------------------------------------------

describe("quoteShellArg / newSession(array)", () => {
  it("quoteShellArg: simples fica cru; espaços e metachars são quotados; ' escapada", () => {
    expect(quoteShellArg("claude")).toBe("claude");
    expect(quoteShellArg("SWITCHBOARD_AGENT_NAME=alpha")).toBe("SWITCHBOARD_AGENT_NAME=alpha");
    expect(quoteShellArg("a b")).toBe("'a b'");
    expect(quoteShellArg("x;rm -rf /")).toBe("'x;rm -rf /'");
    expect(quoteShellArg("it's")).toBe("'it'\\''s'");
    expect(quoteShellArg("")).toBe("''");
  });

  it("newSession(array) junta os elementos shell-quotados num único shell-command", async () => {
    const calls: string[][] = [];
    const exec: ExecFn = async (_file, args) => {
      calls.push([...args]);
      return { stdout: "", stderr: "" };
    };
    const tmux = createTmux({ exec });
    await tmux.newSession("s1", "/tmp", [
      "env",
      "A=b c",
      "claude",
      "--append-system-prompt",
      "x y",
    ]);
    expect(calls).toEqual([
      ["new-session", "-d", "-s", "s1", "-c", "/tmp", "env 'A=b c' claude --append-system-prompt 'x y'"],
    ]);
  });

  it("newSession(string) mantém o comportamento legado (comando cru)", async () => {
    const calls: string[][] = [];
    const exec: ExecFn = async (_file, args) => {
      calls.push([...args]);
      return { stdout: "", stderr: "" };
    };
    const tmux = createTmux({ exec });
    await tmux.newSession("s1", "/tmp", "cat");
    expect(calls).toEqual([["new-session", "-d", "-s", "s1", "-c", "/tmp", "cat"]]);
  });
});

// ---------------------------------------------------------------------------
// formatRelative — LAST SEEN tipo "2min atrás".
// ---------------------------------------------------------------------------

describe("formatRelative", () => {
  const now = Date.parse("2026-07-08T12:00:00.000Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it("timestamps inválidos → —", () => {
    expect(formatRelative("nunca", now)).toBe("—");
    expect(formatRelative("", now)).toBe("—");
  });

  it("< 10s → agora", () => {
    expect(formatRelative(ago(3_000), now)).toBe("agora");
  });

  it("segundos", () => {
    expect(formatRelative(ago(45_000), now)).toBe("45s atrás");
  });

  it("minutos (exemplo da spec: 2min atrás)", () => {
    expect(formatRelative(ago(2 * 60_000), now)).toBe("2min atrás");
  });

  it("horas", () => {
    expect(formatRelative(ago(3 * 3_600_000), now)).toBe("3h atrás");
  });

  it("dias", () => {
    expect(formatRelative(ago(2 * 86_400_000), now)).toBe("2d atrás");
  });
});

// ---------------------------------------------------------------------------
// formatStatusTable — dados fake, formatação limpa.
// ---------------------------------------------------------------------------

describe("formatStatusTable", () => {
  const now = Date.parse("2026-07-08T12:00:00.000Z");
  const rows: StatusRow[] = [
    {
      name: "beta",
      role: "frontend",
      status: "offline",
      mcpConnected: false,
      unreadCount: 0,
      lastSeenAt: new Date(now - 3 * 3_600_000).toISOString(),
      tmuxSession: "sb-beta",
    },
    {
      name: "alpha",
      role: "backend da API",
      status: "online",
      mcpConnected: true,
      unreadCount: 2,
      lastSeenAt: new Date(now - 2 * 60_000).toISOString(),
      tmuxSession: "sb-alpha",
    },
  ];

  it("sem agentes → mensagem orientando o start", () => {
    expect(formatStatusTable([], now)).toMatch(/Nenhum agente registrado/);
  });

  it("cabeçalho NAME | ROLE | STATUS | MCP | UNREAD | LAST SEEN e linhas ordenadas por nome", () => {
    const lines = formatStatusTable(rows, now).split("\n");
    expect(lines[0]).toMatch(/^NAME\s+ROLE\s+STATUS\s+MCP\s+UNREAD\s+LAST SEEN$/);
    expect(lines[1]).toMatch(/^alpha\s+backend da API\s+online\s+sim\s+2\s+2min atrás$/);
    expect(lines[2]).toMatch(/^beta\s+frontend\s+offline\s+não\s+0\s+3h atrás$/);
  });

  it("colunas alinham (toda linha tem as células nas mesmas posições)", () => {
    const lines = formatStatusTable(rows, now).split("\n");
    const statusColumn = lines[0].indexOf("STATUS");
    expect(lines[1].slice(statusColumn)).toMatch(/^online/);
    expect(lines[2].slice(statusColumn)).toMatch(/^offline/);
  });

  it("role vazio vira — e role longo é truncado com …", () => {
    const longRole = "x".repeat(60);
    const table = formatStatusTable(
      [
        { ...rows[0], name: "a1", role: "" },
        { ...rows[0], name: "a2", role: longRole },
      ],
      now,
    );
    expect(table).toMatch(/a1\s+—/);
    expect(table).toContain("x".repeat(39) + "…");
    expect(table).not.toContain(longRole);
  });

  it("campos extras (ex.: um token vazado) NUNCA aparecem — só as 6 colunas são lidas", () => {
    const secret = "deadbeef".repeat(8);
    const dirty = [{ ...rows[0], token: secret } as unknown as StatusRow];
    expect(formatStatusTable(dirty, now)).not.toContain(secret);
  });
});

// ---------------------------------------------------------------------------
// describeDelivery — send imprime o delivery com explicação.
// ---------------------------------------------------------------------------

describe("describeDelivery", () => {
  it("cobre os 4 valores de Delivery com textos distintos e não vazios", () => {
    const values: Delivery[] = ["nudged", "coalesced", "queued_offline", "queued_muted"];
    const texts = values.map(describeDelivery);
    for (const text of texts) expect(text.length).toBeGreaterThan(0);
    expect(new Set(texts).size).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// serveHeaderLines — PRD 11: primeira linha com dashboard + MCP + mcp add.
// ---------------------------------------------------------------------------

describe("serveHeaderLines", () => {
  it("primeira linha traz dashboard, endpoint MCP e o comando claude mcp add prontos", () => {
    const [first, second] = serveHeaderLines("http://127.0.0.1:4577");
    expect(first).toContain("http://127.0.0.1:4577/");
    expect(first).toContain("http://127.0.0.1:4577/mcp");
    expect(first).toContain(
      "claude mcp add --transport http --scope user switchboard http://127.0.0.1:4577/mcp",
    );
    expect(second).toContain("sb-hub");
  });
});

// ---------------------------------------------------------------------------
// runStart — validações locais (sem hub): nome e diretório.
// ---------------------------------------------------------------------------

describe("runStart: validações locais", () => {
  it("nome inválido (mesma regex do store) falha ANTES de qualquer HTTP", async () => {
    await expect(
      runStart({ name: "Bad_Name", hubUrl: "http://127.0.0.1:9" }),
    ).rejects.toThrow(/Nome de agente inválido/);
  });

  it("diretório inexistente falha com mensagem clara", async () => {
    await expect(
      runStart({ name: "okname", dir: "/nao/existe/mesmo", hubUrl: "http://127.0.0.1:9" }),
    ).rejects.toThrow(/Diretório não existe/);
  });

  it("hub morto → erro claro mandando rodar switchboard serve primeiro", async () => {
    await expect(
      runStart({ name: "okname", dir: os.tmpdir(), hubUrl: "http://127.0.0.1:9" }),
    ).rejects.toThrow(/Rode "switchboard serve" primeiro/);
  });

  it("--claude-args inválido falha ANTES de qualquer HTTP/tmux (sem registro fantasma)", async () => {
    const tmuxCalls: string[] = [];
    const tmux = {
      async hasSession(): Promise<boolean> {
        tmuxCalls.push("hasSession");
        return false;
      },
      async newSession(): Promise<void> {
        tmuxCalls.push("newSession");
      },
    };
    await expect(
      runStart({
        name: "okname",
        dir: os.tmpdir(),
        // hub MORTO de propósito: se o parse não fosse fail-fast, o erro
        // observado seria o do health check, não o das aspas.
        hubUrl: "http://127.0.0.1:9",
        baseDir: NO_CONFIG_DIR,
        tmux,
        claudeArgs: "--model 'aberto",
      }),
    ).rejects.toThrow(/não fechadas/);
    expect(tmuxCalls).toEqual([]); // nem tmux, nem HTTP: nada foi tocado
  });

  it('nome "hub" é recusado (sessão sb-hub reservada ao serve) antes de qualquer HTTP', async () => {
    await expect(
      runStart({ name: "hub", hubUrl: "http://127.0.0.1:9", baseDir: NO_CONFIG_DIR }),
    ).rejects.toThrow(/reservada para o próprio Hub/);
  });
});

// ---------------------------------------------------------------------------
// tailLines + runLogs.
// ---------------------------------------------------------------------------

describe("tailLines", () => {
  it("últimas n linhas (newline final ignorado)", () => {
    expect(tailLines("a\nb\nc\nd\n", 2)).toEqual(["c", "d"]);
  });

  it("arquivo menor que n → tudo", () => {
    expect(tailLines("a\nb\n", 100)).toEqual(["a", "b"]);
  });

  it("conteúdo vazio → []", () => {
    expect(tailLines("", 10)).toEqual([]);
  });
});

describe("runLogs", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-cli-logs-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeLog(content: string): string {
    const logDir = path.join(dir, "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const file = path.join(logDir, "hub.log");
    fs.writeFileSync(file, content);
    return file;
  }

  it("arquivo ausente → erro claro (o hub já rodou?)", async () => {
    await expect(runLogs({ baseDir: dir })).rejects.toThrow(/Arquivo de log não existe/);
  });

  it("imprime as últimas ~100 linhas", async () => {
    writeLog(Array.from({ length: 150 }, (_, i) => `linha ${i + 1}`).join("\n") + "\n");
    const out: string[] = [];
    await runLogs({ baseDir: dir, out: (l) => out.push(l) });
    expect(out).toHaveLength(100);
    expect(out[0]).toBe("linha 51");
    expect(out[99]).toBe("linha 150");
  });

  it("-f segue appends (só linhas completas) e sai limpo no abort", async () => {
    const file = writeLog("antiga\n");
    const out: string[] = [];
    const controller = new AbortController();
    const done = runLogs({
      baseDir: dir,
      follow: true,
      pollMs: 20,
      signal: controller.signal,
      out: (l) => out.push(l),
    });

    // A cauda inicial sai primeiro.
    await pollUntil(() => out.includes("antiga"), "cauda inicial");

    fs.appendFileSync(file, "nova 1\nnova 2\nparcial");
    await pollUntil(() => out.includes("nova 2"), "linhas novas completas");
    expect(out).toContain("nova 1");
    // Linha sem newline final ainda NÃO foi emitida.
    expect(out).not.toContain("parcial");

    fs.appendFileSync(file, " completada\n");
    await pollUntil(() => out.includes("parcial completada"), "linha completada");

    controller.abort();
    await done; // resolve limpo (mesmo caminho do Ctrl-C)
  });
});

/** Polls fn until truthy or deadline (no blind sleeps). */
async function pollUntil(
  fn: () => boolean,
  what: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fn()) return;
    if (Date.now() > deadline) throw new Error(`Timeout esperando: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
