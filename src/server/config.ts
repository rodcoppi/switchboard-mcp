// Configuration loading (PRD section 7).
// All values have defaults; ~/.switchboard/config.json may not exist.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Config, LogLevel } from "../shared/types.js";

/**
 * D6 (PRD section 3, non-negotiable): the hub binds EXCLUSIVELY to 127.0.0.1,
 * hard-coded and NOT configurable on purpose. Every delivered message becomes
 * executable input for an agent with filesystem access — exposing this port on
 * the network would be remote code execution for free. Do not turn this into
 * a config key.
 */
export const BIND_HOST = "127.0.0.1";

export const DEFAULTS: Config = {
  port: 4577,
  tmuxSessionPrefix: "sb-",
  nudgeCooldownMs: 15000,
  nudgeEnterDelayMs: 500,
  pairRateLimitPerMinute: 12,
  maxMessageBytes: 16384,
  kickoffDelayMs: 8000,
  agentPollIntervalMs: 10000,
  logLevel: "info",
};

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

/** Default data directory (~/.switchboard). Injectable in tests via loadConfig(baseDir). */
export function defaultBaseDir(): string {
  return path.join(os.homedir(), ".switchboard");
}

/**
 * Loads config from `<baseDir>/config.json`, merging partial user values over
 * DEFAULTS. Rules (PRD section 7):
 * - file may not exist → pure defaults;
 * - unknown keys are ignored;
 * - keys with the wrong type are ignored (warn + keep default);
 * - numeric keys must be positive integers (port additionally <= 65535);
 *   out-of-range values (negative, zero, fractional, Infinity, NaN) are
 *   ignored (warn + keep default) — e.g. a negative nudgeEnterDelayMs would
 *   silently resurrect pitfall P1, and Infinity in a setInterval is clamped
 *   by Node to ~1ms;
 * - invalid JSON → warn + pure defaults (never crash).
 *
 * `baseDir` is injectable so tests never touch the real home directory.
 * Uses console.warn (not log.ts) because the logger itself depends on config.
 */
export function loadConfig(baseDir: string = defaultBaseDir()): Config {
  const file = path.join(baseDir, "config.json");
  if (!fs.existsSync(file)) {
    return { ...DEFAULTS };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    console.warn(
      `[switchboard] config.json inválido em ${file} — usando defaults. Erro: ${String(err)}`,
    );
    return { ...DEFAULTS };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    console.warn(
      `[switchboard] config.json em ${file} não é um objeto JSON — usando defaults.`,
    );
    return { ...DEFAULTS };
  }

  const raw = parsed as Record<string, unknown>;
  const config: Config = { ...DEFAULTS };

  for (const key of Object.keys(DEFAULTS) as (keyof Config)[]) {
    if (!(key in raw)) continue;
    const value = raw[key];
    if (key === "logLevel") {
      if (typeof value === "string" && (LOG_LEVELS as string[]).includes(value)) {
        config.logLevel = value as LogLevel;
      } else {
        console.warn(
          `[switchboard] config.json: valor inválido para "logLevel" (${JSON.stringify(value)}) — usando default "${DEFAULTS.logLevel}".`,
        );
      }
    } else if (typeof DEFAULTS[key] === "number") {
      if (isValidNumericValue(key, value)) {
        (config as unknown as Record<string, unknown>)[key] = value;
      } else {
        console.warn(
          `[switchboard] config.json: valor inválido para "${key}" (${JSON.stringify(value)}) — usando default.`,
        );
      }
    } else if (typeof value === typeof DEFAULTS[key]) {
      (config as unknown as Record<string, unknown>)[key] = value;
    } else {
      console.warn(
        `[switchboard] config.json: valor inválido para "${key}" (${JSON.stringify(value)}) — usando default.`,
      );
    }
  }

  return config;
}

/**
 * Sanity range for numeric config keys: positive integer (Number.isInteger
 * also rejects Infinity and NaN, which JSON.parse can produce via 1e309),
 * and port within the TCP range.
 */
function isValidNumericValue(key: keyof Config, value: unknown): value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return false;
  }
  if (key === "port" && value > 65535) {
    return false;
  }
  return true;
}
