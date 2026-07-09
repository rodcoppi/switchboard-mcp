// Unit tests for config loading (PRD section 7).
// Every test runs against a fresh temp directory (never the real ~/.switchboard).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { BIND_HOST, DEFAULTS, ensureConfigFile, loadConfig } from "../src/server/config.js";

let dir: string;
let warnSpy: MockInstance;

function writeConfig(content: string): void {
  fs.writeFileSync(path.join(dir, "config.json"), content);
}

function warnings(): string[] {
  return warnSpy.mock.calls.map((call) => String(call[0]));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-config-test-"));
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("binds exclusively to 127.0.0.1 (D6, not configurable)", () => {
    expect(BIND_HOST).toBe("127.0.0.1");
  });

  it("returns pure defaults when the file does not exist (no warn)", () => {
    expect(loadConfig(dir)).toEqual(DEFAULTS);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("returns defaults + warn on invalid JSON (never crash)", () => {
    writeConfig("{isto não é JSON");
    expect(loadConfig(dir)).toEqual(DEFAULTS);
    expect(warnings().some((w) => w.includes("config.json inválido"))).toBe(true);
  });

  it("returns defaults + warn when the JSON is not an object", () => {
    for (const bad of ['["array"]', '"string"', "42"]) {
      warnSpy.mockClear();
      writeConfig(bad);
      expect(loadConfig(dir)).toEqual(DEFAULTS);
      expect(warnings().some((w) => w.includes("não é um objeto"))).toBe(true);
    }
  });

  it("merges a valid partial override over the defaults", () => {
    writeConfig(JSON.stringify({ port: 4999, tmuxSessionPrefix: "x-", logLevel: "debug" }));
    const config = loadConfig(dir);
    expect(config.port).toBe(4999);
    expect(config.tmuxSessionPrefix).toBe("x-");
    expect(config.logLevel).toBe("debug");
    // untouched keys keep their defaults
    expect(config.nudgeCooldownMs).toBe(DEFAULTS.nudgeCooldownMs);
    expect(config.maxMessageBytes).toBe(DEFAULTS.maxMessageBytes);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("ignores unknown keys silently", () => {
    writeConfig(JSON.stringify({ chaveDesconhecida: true, port: 5000 }));
    const config = loadConfig(dir);
    expect(config.port).toBe(5000);
    expect("chaveDesconhecida" in config).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("keeps the default + warns on wrong type (port as string)", () => {
    writeConfig(JSON.stringify({ port: "4578", tmuxSessionPrefix: 12 }));
    const config = loadConfig(dir);
    expect(config.port).toBe(DEFAULTS.port);
    expect(config.tmuxSessionPrefix).toBe(DEFAULTS.tmuxSessionPrefix);
    expect(warnings().filter((w) => w.includes("valor inválido"))).toHaveLength(2);
  });

  it("keeps the default + warns on logLevel outside the enum", () => {
    writeConfig(JSON.stringify({ logLevel: "verbose" }));
    expect(loadConfig(dir).logLevel).toBe(DEFAULTS.logLevel);
    expect(warnings().some((w) => w.includes("logLevel"))).toBe(true);
  });

  it("rejects out-of-range numbers (negative, zero, fractional, Infinity, port > 65535)", () => {
    // raw JSON text: 1e309 must reach JSON.parse (which turns it into
    // Infinity) — JSON.stringify would have serialized it as null
    writeConfig(
      `{
        "port": -1,
        "nudgeEnterDelayMs": -500,
        "maxMessageBytes": 0.5,
        "pairRateLimitPerMinute": 0,
        "agentPollIntervalMs": 1e309
      }`,
      // -500 would resurrect pitfall P1 silently; 0.5 would reject every
      // message in Phase 2; 0 would disable the anti-loop; Infinity in a
      // setInterval is clamped by Node to ~1ms (has-session spam in Phase 3)
    );
    const config = loadConfig(dir);
    expect(config).toEqual(DEFAULTS);
    expect(warnings().filter((w) => w.includes("valor inválido"))).toHaveLength(5);

    warnSpy.mockClear();
    writeConfig(JSON.stringify({ port: 70000 }));
    expect(loadConfig(dir).port).toBe(DEFAULTS.port);
    expect(warnings().some((w) => w.includes("port"))).toBe(true);
  });

  it("accepts in-range numeric overrides", () => {
    writeConfig(
      JSON.stringify({
        port: 65535,
        nudgeEnterDelayMs: 750,
        pairRateLimitPerMinute: 1,
        maxMessageBytes: 1024,
      }),
    );
    const config = loadConfig(dir);
    expect(config.port).toBe(65535);
    expect(config.nudgeEnterDelayMs).toBe(750);
    expect(config.pairRateLimitPerMinute).toBe(1);
    expect(config.maxMessageBytes).toBe(1024);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("ensureConfigFile", () => {
  it("creates config.json with every default on the first serve (PRD section 7)", () => {
    const file = path.join(dir, "config.json");
    expect(fs.existsSync(file)).toBe(false);
    ensureConfigFile(dir);
    expect(fs.existsSync(file)).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(DEFAULTS);
    // the freshly written file loads back as pure defaults, no warns
    expect(loadConfig(dir)).toEqual(DEFAULTS);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("never overwrites nor normalizes an existing config.json", () => {
    // even an INVALID existing file is preserved verbatim (the read-side
    // merge already tolerates it); ensureConfigFile must not touch it
    writeConfig('{"port": 4999, "chaveDesconhecida": true}');
    const before = fs.readFileSync(path.join(dir, "config.json"), "utf8");
    ensureConfigFile(dir);
    expect(fs.readFileSync(path.join(dir, "config.json"), "utf8")).toBe(before);
    expect(loadConfig(dir).port).toBe(4999);
  });
});
