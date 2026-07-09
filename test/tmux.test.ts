// Unit tests for the tmux wrapper (PRD 10.3) with a mocked ExecFn (DI):
// - exact targets per command class: "=NAME" for has-session/kill-session,
//   "=NAME:" for send-keys/capture-pane/list-panes (spikes/NOTES.md, tmux 3.4);
// - send-keys always with -l and -- (P9/P5);
// - pane guard is an ALLOW-LIST (PRD 10.3, default-deny): only
//   node/claude/claude-code/cat are safe; shells, REPLs, ssh, anything else
//   and error/empty are all unsafe (fail-closed);
// - TOCTOU: the guard re-runs before the separate Enter and suppresses it
//   when the pane became unsafe during the delay;
// - newline sanitization (nudgeSession flattens; sendKeysLiteral throws).

import { describe, expect, it } from "vitest";
import {
  createTmux,
  isSafePaneCommand,
  type ExecFn,
  type ExecResult,
} from "../src/server/tmux.js";

interface RecordedCall {
  file: string;
  args: string[];
}

/**
 * ExecFn mock: records every call and answers via the handler (return string
 * = stdout; throw = non-zero exit, like promisified execFile).
 */
function fakeExec(
  handler: (args: string[]) => string | Promise<string> = () => "",
): { exec: ExecFn; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const exec: ExecFn = async (file, args): Promise<ExecResult> => {
    calls.push({ file, args });
    const stdout = await handler(args);
    return { stdout, stderr: "" };
  };
  return { exec, calls };
}

describe("targets exatos por comando (achado crítico do NOTES.md, tmux 3.4)", () => {
  it('has-session usa -t "=NOME" (sem dois-pontos)', async () => {
    const { exec, calls } = fakeExec();
    const tmux = createTmux({ exec });
    expect(await tmux.hasSession("sb-alpha")).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe("tmux");
    expect(calls[0].args).toEqual(["has-session", "-t", "=sb-alpha"]);
  });

  it("hasSession devolve false quando o exec falha (exit != 0), sem lançar", async () => {
    const { exec, calls } = fakeExec(() => {
      throw new Error("can't find session: =sb-alpha");
    });
    const tmux = createTmux({ exec });
    expect(await tmux.hasSession("sb-alpha")).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('kill-session usa -t "=NOME" (sem dois-pontos)', async () => {
    const { exec, calls } = fakeExec();
    const tmux = createTmux({ exec });
    await tmux.killSession("sb-alpha");
    expect(calls[0].args).toEqual(["kill-session", "-t", "=sb-alpha"]);
  });

  it('list-panes (paneCommand) usa -t "=NOME:" (com dois-pontos)', async () => {
    const { exec, calls } = fakeExec(() => "claude\n");
    const tmux = createTmux({ exec });
    expect(await tmux.paneCommand("sb-alpha")).toBe("claude");
    expect(calls[0].args).toEqual([
      "list-panes",
      "-t",
      "=sb-alpha:",
      "-F",
      "#{pane_current_command}",
    ]);
  });

  it('send-keys literal usa -t "=NOME:" com -l e -- antes do texto (P9/P5)', async () => {
    const { exec, calls } = fakeExec();
    const tmux = createTmux({ exec });
    await tmux.sendKeysLiteral("sb-alpha", "-começa com hífen");
    expect(calls[0].args).toEqual([
      "send-keys",
      "-t",
      "=sb-alpha:",
      "-l",
      "--",
      "-começa com hífen",
    ]);
  });

  it('sendEnter usa -t "=NOME:" e a tecla Enter, SEM -l', async () => {
    const { exec, calls } = fakeExec();
    const tmux = createTmux({ exec });
    await tmux.sendEnter("sb-alpha");
    expect(calls[0].args).toEqual(["send-keys", "-t", "=sb-alpha:", "Enter"]);
    expect(calls[0].args).not.toContain("-l");
  });

  it('capture-pane usa -t "=NOME:" com -p -S -<linhas>', async () => {
    const { exec, calls } = fakeExec(() => "conteudo do pane\n");
    const tmux = createTmux({ exec });
    expect(await tmux.capturePane("sb-alpha", 60)).toBe("conteudo do pane\n");
    expect(calls[0].args).toEqual(["capture-pane", "-t", "=sb-alpha:", "-p", "-S", "-60"]);

    // default de linhas
    await tmux.capturePane("sb-alpha");
    expect(calls[1].args).toEqual(["capture-pane", "-t", "=sb-alpha:", "-p", "-S", "-200"]);
  });

  it("new-session usa -d -s <nome> -c <cwd> [<cmd>]", async () => {
    const { exec, calls } = fakeExec();
    const tmux = createTmux({ exec });
    await tmux.newSession("sb-alpha", "/tmp/repo-a", "claude");
    expect(calls[0].args).toEqual([
      "new-session",
      "-d",
      "-s",
      "sb-alpha",
      "-c",
      "/tmp/repo-a",
      "claude",
    ]);

    await tmux.newSession("sb-beta", "/tmp/repo-b");
    expect(calls[1].args).toEqual(["new-session", "-d", "-s", "sb-beta", "-c", "/tmp/repo-b"]);
  });

  it("listSessions filtra por prefixo e devolve [] quando o server tmux está morto", async () => {
    const { exec } = fakeExec(() => "sb-alpha\nsb-beta\noutra\n");
    const tmux = createTmux({ exec });
    expect(await tmux.listSessions("sb-")).toEqual(["sb-alpha", "sb-beta"]);

    const dead = createTmux({
      exec: fakeExec(() => {
        throw new Error("no server running");
      }).exec,
    });
    expect(await dead.listSessions("sb-")).toEqual([]);
  });

  it('nome de sessão inválido (vazio, ":" ou espaço) é rejeitado antes de tocar o tmux', async () => {
    const { exec, calls } = fakeExec();
    const tmux = createTmux({ exec });
    for (const bad of ["", "a:b", "a b", "a\nb"]) {
      await expect(tmux.hasSession(bad)).rejects.toThrow(/inválido/);
      await expect(tmux.sendKeysLiteral(bad, "x")).rejects.toThrow(/inválido/);
    }
    expect(calls).toHaveLength(0);
  });
});

describe("guarda de pane (PRD 10.3/P2, não negociável) — ALLOW-LIST, FAIL-CLOSED", () => {
  it.each(["bash", "zsh", "sh", "dash", "fish", "ksh", "csh", "tcsh", "busybox"])(
    'pane rodando o shell "%s" é INSEGURO',
    async (shell) => {
      const { exec } = fakeExec(() => `${shell}\n`);
      const tmux = createTmux({ exec });
      expect(await tmux.isPaneSafeToNudge("sb-alpha")).toBe(false);
    },
  );

  it.each([
    // shells modernos que a antiga deny-list não cobria
    "pwsh",
    "powershell",
    "nu",
    "nushell",
    "xonsh",
    "elvish",
    // REPLs/remotos: interpretariam ou encaminhariam o texto digitado
    "python3",
    "ipython",
    "perl",
    "ruby",
    "psql",
    "mysql",
    "sqlite3",
    "ssh",
    "nc",
    "socat",
    "telnet",
    // qualquer coisa fora da allow-list é insegura (default-deny)
    "vim",
    "htop",
  ])('pane rodando "%s" (fora da allow-list) é INSEGURO — default-deny', async (cmd) => {
    const { exec } = fakeExec(() => `${cmd}\n`);
    const tmux = createTmux({ exec });
    expect(await tmux.isPaneSafeToNudge("sb-alpha")).toBe(false);
  });

  it.each(["claude", "node", "claude-code", "cat"])(
    'pane rodando "%s" (allow-list) é seguro',
    async (cmd) => {
      const { exec } = fakeExec(() => `${cmd}\n`);
      const tmux = createTmux({ exec });
      expect(await tmux.isPaneSafeToNudge("sb-alpha")).toBe(true);
    },
  );

  it("pane_current_command vazio → inseguro (fail-closed)", async () => {
    const { exec } = fakeExec(() => "");
    const tmux = createTmux({ exec });
    expect(await tmux.isPaneSafeToNudge("sb-alpha")).toBe(false);
  });

  it("erro lendo o pane (sessão morta) → inseguro (fail-closed), sem lançar", async () => {
    const { exec } = fakeExec(() => {
      throw new Error("can't find pane: =sb-alpha:");
    });
    const tmux = createTmux({ exec });
    expect(await tmux.isPaneSafeToNudge("sb-alpha")).toBe(false);
  });

  it("múltiplos panes: QUALQUER pane em shell torna a sessão insegura", async () => {
    const { exec } = fakeExec(() => "claude\nbash\n");
    const tmux = createTmux({ exec });
    expect(await tmux.isPaneSafeToNudge("sb-alpha")).toBe(false);
  });

  it("normalização defensiva: path completo, maiúsculas e login shell (-bash)", () => {
    expect(isSafePaneCommand("/usr/bin/bash")).toBe(false);
    expect(isSafePaneCommand("BASH")).toBe(false);
    expect(isSafePaneCommand("-bash")).toBe(false);
    expect(isSafePaneCommand("/usr/bin/python3")).toBe(false);
    expect(isSafePaneCommand("/usr/local/bin/claude")).toBe(true);
    expect(isSafePaneCommand("CLAUDE")).toBe(true);
    // cat é seguro (não interpreta texto como comando) — o Done When da
    // Phase 3 exige que uma sessão `cat` receba nudge (PRD seção 16).
    expect(isSafePaneCommand("cat")).toBe(true);
  });
});

describe("nudgeSession (nudge de alto nível: guarda + texto + Enter separado)", () => {
  it("pane seguro: envia texto literal, aguarda o delay e envia Enter em comando SEPARADO", async () => {
    const timeline: string[] = [];
    const { exec, calls } = fakeExec((args) => {
      if (args[0] === "list-panes") return "claude\n";
      timeline.push(args.join(" "));
      return "";
    });
    let slept = -1;
    const tmux = createTmux({
      exec,
      sleep: async (ms) => {
        slept = ms;
        timeline.push(`sleep ${ms}`);
      },
    });

    const result = await tmux.nudgeSession("sb-alpha", "[switchboard] oi", 500);
    expect(result).toEqual({ sent: true });
    expect(slept).toBe(500);

    // Ordem: guarda (list-panes) → texto literal → delay → RE-guarda
    // (TOCTOU) → Enter (separado).
    expect(calls.map((c) => c.args[0])).toEqual([
      "list-panes",
      "send-keys",
      "list-panes",
      "send-keys",
    ]);
    expect(timeline).toEqual([
      "send-keys -t =sb-alpha: -l -- [switchboard] oi",
      "sleep 500",
      "send-keys -t =sb-alpha: Enter",
    ]);
  });

  it("TOCTOU: pane fica inseguro DURANTE o delay → Enter é SUPRIMIDO (re-guarda antes do Enter)", async () => {
    // 1ª list-panes (guarda): claude. 2ª (re-guarda pós-delay): bash — o
    // claude morreu no meio do caminho e o pane caiu num shell (P2).
    let paneReads = 0;
    const { exec, calls } = fakeExec((args) => {
      if (args[0] === "list-panes") {
        paneReads += 1;
        return paneReads === 1 ? "claude\n" : "bash\n";
      }
      return "";
    });
    const tmux = createTmux({ exec, sleep: async () => {} });

    const result = await tmux.nudgeSession("sb-alpha", "[switchboard] oi", 500);
    expect(result.sent).toBe(false);
    expect(result.reason).toContain("Enter suprimido");

    // O texto chegou a ser digitado (fica inerte no prompt), mas NENHUM
    // Enter foi enviado — nada é submetido num pane inseguro.
    const sendKeys = calls.filter((c) => c.args[0] === "send-keys");
    expect(sendKeys).toHaveLength(1);
    expect(sendKeys[0].args).toContain("-l");
    expect(sendKeys[0].args).not.toContain("Enter");
    expect(paneReads).toBe(2);
  });

  it("pane inseguro (shell): NÃO envia NENHUM send-keys e reporta o motivo", async () => {
    const { exec, calls } = fakeExec((args) => {
      if (args[0] === "list-panes") return "bash\n";
      return "";
    });
    const tmux = createTmux({ exec, sleep: async () => {} });

    const result = await tmux.nudgeSession("sb-alpha", "[switchboard] oi", 500);
    expect(result.sent).toBe(false);
    expect(result.reason).toContain("bash");
    expect(calls.filter((c) => c.args[0] === "send-keys")).toHaveLength(0);
  });

  it("pane ilegível (sessão morta): fail-closed, nenhum send-keys", async () => {
    const { exec, calls } = fakeExec(() => {
      throw new Error("can't find pane");
    });
    const tmux = createTmux({ exec, sleep: async () => {} });

    const result = await tmux.nudgeSession("sb-alpha", "oi", 0);
    expect(result.sent).toBe(false);
    expect(result.reason).toContain("fail-closed");
    expect(calls.filter((c) => c.args[0] === "send-keys")).toHaveLength(0);
  });

  it("achata \\r/\\n do texto antes de digitar (nudge é SEMPRE uma linha — P5)", async () => {
    const { exec, calls } = fakeExec((args) =>
      args[0] === "list-panes" ? "claude\n" : "",
    );
    const tmux = createTmux({ exec, sleep: async () => {} });

    await tmux.nudgeSession("sb-alpha", "linha1\nlinha2\r\nlinha3", 0);
    const literal = calls.find((c) => c.args.includes("-l"))!;
    expect(literal.args[literal.args.length - 1]).toBe("linha1 linha2 linha3");
  });

  it("sendKeysLiteral LANÇA para texto com newline (defesa em profundidade)", async () => {
    const { exec, calls } = fakeExec();
    const tmux = createTmux({ exec });
    await expect(tmux.sendKeysLiteral("sb-alpha", "a\nb")).rejects.toThrow(/uma linha/);
    await expect(tmux.sendKeysLiteral("sb-alpha", "a\rb")).rejects.toThrow(/uma linha/);
    expect(calls).toHaveLength(0); // nada chegou ao tmux
  });
});
