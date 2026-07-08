// Simple leveled logger (PRD section 6: "logger simples com níveis, arquivo + stdout").
// No external dependencies. Writes every record to stdout AND appends it to a
// log file (default ~/.switchboard/logs/hub.log, directory created on demand).
// Debuggability > elegance (PRD override rule 2): plain text, greppable.

import fs from "node:fs";
import path from "node:path";
import type { LogLevel } from "../shared/types.js";
import { defaultBaseDir } from "./config.js";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface LoggerOptions {
  /** Minimum level to record (default "info"). */
  level?: LogLevel;
  /** Log file path, injectable for tests (default <~/.switchboard>/logs/hub.log). */
  filePath?: string;
  /**
   * Disable stdout mirroring (useful in tests). The file is written whenever
   * its directory is available (see the constructor fallback).
   */
  stdout?: boolean;
}

export class Logger {
  private minLevel: LogLevel;
  private filePath: string;
  private stdout: boolean;
  // Set when the log directory could not be created: the logger degrades to
  // stdout-only instead of crashing the hub (a LOG failure must never take
  // the message service down — PRD section 4, reliability first).
  private fileDisabled = false;

  constructor(options: LoggerOptions = {}) {
    this.minLevel = options.level ?? "info";
    this.filePath =
      options.filePath ?? path.join(defaultBaseDir(), "logs", "hub.log");
    this.stdout = options.stdout ?? true;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    } catch (err) {
      this.fileDisabled = true;
      process.stderr.write(
        `[switchboard] não foi possível criar o diretório de logs ${path.dirname(this.filePath)} ` +
          `(${String(err)}) — logando apenas em stdout.\n`,
      );
    }
  }

  setLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  debug(message: string, ...args: unknown[]): void {
    this.write("debug", message, args);
  }

  info(message: string, ...args: unknown[]): void {
    this.write("info", message, args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.write("warn", message, args);
  }

  error(message: string, ...args: unknown[]): void {
    this.write("error", message, args);
  }

  private write(level: LogLevel, message: string, args: unknown[]): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;
    const extra = args.length > 0 ? " " + args.map(formatArg).join(" ") : "";
    const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${message}${extra}\n`;
    if (this.stdout) process.stdout.write(line);
    if (this.fileDisabled) return; // directory unavailable — stdout-only mode
    try {
      fs.appendFileSync(this.filePath, line);
    } catch {
      // Never crash the hub because the log file became unwritable; the
      // stdout copy (when enabled) still carries the record.
    }
  }
}

function formatArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return arg.stack ?? arg.message;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  return new Logger(options);
}
