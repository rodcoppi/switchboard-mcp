// E2E leve da camada commander (src/index.ts + register*Command) através do
// bin real (bin/switchboard.mjs → tsx do repo → src/index.ts): cobre o
// mapeamento de flags, o comando oculto, os exit codes (CliError → 1) e a
// validação do serve — regressões que os testes de run*/format* (que pulam o
// commander) nunca veriam. Nenhum hub, nenhum tmux, nenhum claude: só os
// caminhos de erro fail-fast (validações locais ANTES de qualquer HTTP) e o
// --help. Barato (~1-2s por spawn), determinístico, nenhuma porta.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const bin = path.join(repoRoot, "bin", "switchboard.mjs");

function cli(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [bin, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    cwd: repoRoot,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("CLI E2E (bin real → commander)", () => {
  it("--help lista os 7 subcomandos públicos e ESCONDE o kickoff-agent", () => {
    const { status, stdout } = cli("--help");
    expect(status).toBe(0);
    for (const cmd of ["serve", "start", "status", "send", "stop", "down", "logs"]) {
      expect(stdout).toMatch(new RegExp(`^\\s{2}${cmd}\\b`, "m"));
    }
    expect(stdout).not.toContain("kickoff-agent");
  }, 40_000);

  it("start com nome inválido → exit 1 + mensagem da CliError (sem stack)", () => {
    const { status, stderr } = cli("start", "Bad_Name");
    expect(status).toBe(1);
    expect(stderr).toMatch(/Nome de agente inválido/);
    expect(stderr).not.toMatch(/erro inesperado/);
  }, 40_000);

  it("start com --dir inexistente → exit 1 + mensagem clara", () => {
    const { status, stderr } = cli("start", "okname", "--dir", "/nao/existe/mesmo");
    expect(status).toBe(1);
    expect(stderr).toMatch(/Diretório não existe/);
  }, 40_000);

  it("start com --claude-args de aspas abertas → exit 1 ANTES de qualquer HTTP (flag mapeada)", () => {
    // Prova que o commander entrega --claude-args → opts.claudeArgs: se o
    // mapeamento quebrasse (undefined), o parse passaria e o erro seria outro
    // (hub morto / diretório), não o das aspas.
    const { status, stderr } = cli("start", "okname", "--claude-args", "--model 'aberto");
    expect(status).toBe(1);
    expect(stderr).toMatch(/não fechadas/);
  }, 40_000);

  it("serve com --port inválida → exit 1 + mensagem dirigida", () => {
    const { status, stderr } = cli("serve", "--port", "abc");
    expect(status).toBe(1);
    expect(stderr).toMatch(/porta inválida/);
  }, 40_000);
});
