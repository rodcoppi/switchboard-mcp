// Lightweight E2E of the commander layer (src/index.ts + register*Command)
// through the real bin (bin/switchboard.mjs → repo tsx → src/index.ts): covers
// the flag mapping, the hidden command, the exit codes (CliError → 1) and the
// serve validation — regressions the run*/format* tests (which skip commander)
// would never catch. No hub, no tmux, no claude: only the fail-fast error paths
// (local validations BEFORE any HTTP) and --help. Cheap (~1-2s per spawn),
// deterministic, no ports.

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

describe("CLI E2E (real bin → commander)", () => {
  it("--help lists the 7 public subcommands and HIDES the kickoff-agent", () => {
    const { status, stdout } = cli("--help");
    expect(status).toBe(0);
    for (const cmd of ["serve", "start", "status", "send", "stop", "down", "logs"]) {
      expect(stdout).toMatch(new RegExp(`^\\s{2}${cmd}\\b`, "m"));
    }
    expect(stdout).not.toContain("kickoff-agent");
  }, 40_000);

  it("start with an invalid name → exit 1 + CliError message (no stack)", () => {
    const { status, stderr } = cli("start", "Bad_Name");
    expect(status).toBe(1);
    expect(stderr).toMatch(/Invalid agent name/);
    expect(stderr).not.toMatch(/unexpected error/);
  }, 40_000);

  it("start with a non-existent --dir → exit 1 + clear message", () => {
    const { status, stderr } = cli("start", "okname", "--dir", "/does/not/exist");
    expect(status).toBe(1);
    expect(stderr).toMatch(/Directory does not exist/);
  }, 40_000);

  it("start with an unterminated quote in --claude-args → exit 1 BEFORE any HTTP (flag mapped)", () => {
    // Proves that commander delivers --claude-args → opts.claudeArgs: if the
    // mapping broke (undefined), the parse would pass and the error would be a
    // different one (dead hub / directory), not the quote one.
    const { status, stderr } = cli("start", "okname", "--claude-args", "--model 'open");
    expect(status).toBe(1);
    expect(stderr).toMatch(/unterminated/);
  }, 40_000);

  it("serve with an invalid --port → exit 1 + directed message", () => {
    const { status, stderr } = cli("serve", "--port", "abc");
    expect(status).toBe(1);
    expect(stderr).toMatch(/invalid port/);
  }, 40_000);
});
