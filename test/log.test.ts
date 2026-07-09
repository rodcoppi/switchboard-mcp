// Unit tests for the leveled logger (PRD section 6).
// Every test runs against a fresh temp directory (never the real ~/.switchboard).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger, createLogger } from "../src/server/log.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-log-test-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("Logger", () => {
  it("filters records below the minimum level and appends the rest to the file", () => {
    const filePath = path.join(dir, "logs", "hub.log");
    const logger = createLogger({ level: "warn", filePath, stdout: false });
    logger.debug("debug message");
    logger.info("info message");
    logger.warn("warn message");
    logger.error("error message", new Error("detail"));

    const content = fs.readFileSync(filePath, "utf8");
    expect(content).not.toContain("[DEBUG]");
    expect(content).not.toContain("[INFO]");
    expect(content).toContain("[WARN] warn message");
    expect(content).toContain("[ERROR] error message");
    expect(content).toContain("detail"); // extra args are formatted in
  });

  it("setLevel changes the filter at runtime", () => {
    const filePath = path.join(dir, "hub.log");
    const logger = new Logger({ level: "error", filePath, stdout: false });
    logger.info("before");
    logger.setLevel("debug");
    logger.debug("after");

    const content = fs.readFileSync(filePath, "utf8");
    expect(content).not.toContain("before");
    expect(content).toContain("after");
  });

  it("never crashes the hub when the log directory cannot be created (stdout-only fallback)", () => {
    // logs path blocked by a FILE where a directory is needed
    const blocker = path.join(dir, "blocker");
    fs.writeFileSync(blocker, "I am a file, not a directory");
    const filePath = path.join(blocker, "sub", "hub.log");

    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      let logger!: Logger;
      expect(() => {
        logger = new Logger({ filePath, stdout: false });
      }).not.toThrow();
      // warned once on stderr about the fallback
      expect(
        stderrSpy.mock.calls.some((call) => String(call[0]).includes("stdout")),
      ).toBe(true);
      // writing still works (no throw), just without the file copy
      expect(() => logger.error("still works")).not.toThrow();
      expect(fs.existsSync(filePath)).toBe(false);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("mirrors records to stdout when enabled", () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      const logger = new Logger({ filePath: path.join(dir, "hub.log") });
      logger.info("no stdout");
      expect(
        stdoutSpy.mock.calls.some((call) =>
          String(call[0]).includes("[INFO] no stdout"),
        ),
      ).toBe(true);
    } finally {
      stdoutSpy.mockRestore();
    }
  });
});
