// Hub assembly (PRD sections 6 and 10): ONE Node process serving the MCP
// Streamable HTTP endpoint (/mcp), REST + SSE for dashboard/CLI (/api/*) and
// the static dashboard (/). Exported as startHub() so tests can run it on an
// ephemeral port with a temp data dir and close it cleanly.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import express from "express";
import type { Config, LogLevel, OnMessage } from "../shared/types.js";
import { BIND_HOST, defaultBaseDir, ensureConfigFile, loadConfig } from "./config.js";
import { Logger, createLogger } from "./log.js";
import { Store } from "./store.js";
import { PairRateLimiter } from "./ratelimit.js";
import { EventBus, createApiRouter } from "./api.js";
import { createMcpEndpoint } from "./mcp.js";
import { createTmux } from "./tmux.js";
import { Dispatcher } from "./dispatcher.js";
import { createLauncher, type Launcher, type LauncherTuning } from "./launcher.js";

export interface HubOptions {
  /** Data directory (default ~/.switchboard). Tests MUST inject a temp dir. */
  baseDir?: string;
  /** Overrides config.port. 0 = ephemeral (tests); production uses config. */
  port?: number;
  /** Overrides config.logLevel (CLI --log-level). */
  logLevel?: LogLevel;
  /** Suppresses stdout logging (tests); the log file is still written. */
  quiet?: boolean;
  /**
   * Delivery extension point override. When omitted (production), the hub
   * creates the Phase 3 tmux nudge Dispatcher (cooldown, coalescing, status
   * polling) and uses dispatcher.onNewMessage. When provided (tests), the
   * override replaces the dispatcher entirely: no tmux is ever touched and
   * the manual-nudge endpoint answers 501.
   */
  onMessage?: OnMessage;
  /**
   * Launcher tuning (tests: fake claude binary, shorter settle/poll). Only
   * consulted when the hub creates the REAL launcher — i.e. when onMessage is
   * NOT overridden. A hub with a custom onMessage has no launcher at all and
   * POST /api/agents/launch answers 501 (like the manual-nudge placeholder).
   */
  launcher?: LauncherTuning;
  /**
   * Claude Code projects dir for the folder browser's "conversation" badge
   * (GET /api/fs/dirs). Default ~/.claude/projects; tests MUST inject a temp
   * dir so they never read the operator's real conversation index.
   */
  claudeProjectsDir?: string;
  /** MCP session idle expiry / sweep cadence — injectable for tests. */
  sessionIdleTimeoutMs?: number;
  sessionSweepIntervalMs?: number;
  /** SSE heartbeat interval — injectable for tests. */
  heartbeatMs?: number;
}

export interface Hub {
  /** Effective port (resolved when options.port = 0). */
  port: number;
  url: string;
  baseDir: string;
  config: Config;
  store: Store;
  log: Logger;
  close(): Promise<void>;
}

/**
 * express.json() (via raw-body/http-errors) throws PayloadTooLargeError for
 * bodies over `limit`: status 413, type "entity.too.large". It is NOT a
 * SyntaxError, so without this check it would fall through to the generic
 * 500 branch of the error middleware.
 */
function isPayloadTooLarge(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { type?: unknown; status?: unknown; statusCode?: unknown };
  return e.type === "entity.too.large" || e.status === 413 || e.statusCode === 413;
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export async function startHub(options: HubOptions = {}): Promise<Hub> {
  const baseDir = options.baseDir ?? defaultBaseDir();
  fs.mkdirSync(baseDir, { recursive: true });

  // PRD section 7: config.json is created with the defaults on the first
  // serve (never overwritten), so every key is discoverable and editable.
  ensureConfigFile(baseDir);
  const config = loadConfig(baseDir);
  if (options.logLevel) config.logLevel = options.logLevel;
  const port = options.port ?? config.port;

  const log = createLogger({
    level: config.logLevel,
    filePath: path.join(baseDir, "logs", "hub.log"),
    stdout: !options.quiet,
  });
  const store = new Store(baseDir, log);
  // Boot reconciliation: no MCP session survives a hub restart (the session →
  // agent Map is in-memory), so mcpConnected/online loaded from agents.json is
  // ghost state from a non-graceful shutdown (kill -9, power loss) — reset it
  // before anything can join, or dead agents would stay "connected" forever.
  store.resetConnectionState();
  const bus = new EventBus();
  const rateLimiter = new PairRateLimiter({
    limitPerMinute: config.pairRateLimitPerMinute,
  });

  // Phase 3 delivery: the tmux nudge Dispatcher (PRD 10.2) is the default
  // onMessage. Tests may inject options.onMessage instead — then no
  // dispatcher (and no tmux) exists at all.
  let dispatcher: Dispatcher | undefined;
  let launcher: Launcher | undefined;
  let onMessage: OnMessage;
  if (options.onMessage) {
    onMessage = options.onMessage;
  } else {
    const tmux = createTmux();
    dispatcher = new Dispatcher({ store, config, log, bus, tmux });
    onMessage = dispatcher.onNewMessage;
    // Dashboard "Launch agent": same real tmux layer as the dispatcher. Tests
    // that stub onMessage get NO launcher (endpoint answers 501).
    launcher = createLauncher({ store, tmux, config, log, bus, ...options.launcher });
  }

  const version = readVersion();
  const startedAt = Date.now();

  const app = express();
  // The parser limit must sit ABOVE config.maxMessageBytes: with the express
  // default (100kb), a body in the range (100 KB, maxMessageBytes] would die
  // inside express.json() with a bare 500 before validateBodySize could
  // answer with the instructive file+path error — and a raised
  // maxMessageBytes would be silently non-functional. 2x + slack covers the
  // JSON string escaping of a maxMessageBytes-sized message plus the JSON-RPC
  // envelope; the 1 MB floor keeps the default config (16 KB) generous.
  const jsonBodyLimitBytes = Math.max(config.maxMessageBytes * 2 + 4096, 1_000_000);
  app.use(express.json({ limit: jsonBodyLimitBytes }));

  const mcp = createMcpEndpoint({
    store,
    config,
    log,
    bus,
    rateLimiter,
    onMessage,
    sessionIdleTimeoutMs: options.sessionIdleTimeoutMs,
    sessionSweepIntervalMs: options.sessionSweepIntervalMs,
  });
  app.use(mcp.router);

  app.use(
    createApiRouter({
      store,
      config,
      log,
      bus,
      onMessage,
      nudger: dispatcher,
      launcher,
      claudeProjectsDir: options.claudeProjectsDir,
      startedAt,
      version,
      heartbeatMs: options.heartbeatMs,
    }),
  );

  // Static dashboard (Phase 6). Serving is wired now so public/index.html
  // just appears when the phase lands; until then, / answers 404.
  const publicDir = fileURLToPath(new URL("../../public", import.meta.url));
  if (fs.existsSync(publicDir)) {
    app.use(express.static(publicDir));
  }

  // Malformed JSON body throws inside express.json(), BEFORE any handler
  // (spike NOTES.md finding 5): answer in-protocol instead of the Express
  // HTML error page — JSON-RPC -32700 on /mcp, {ok:false} JSON on the rest.
  // Bodies over the parser limit also throw in there (PayloadTooLargeError,
  // type "entity.too.large"): answer 413 with the same self-correcting
  // file+path instruction validateBodySize emits, never a bare 500.
  app.use(
    (
      err: unknown,
      req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      if (isPayloadTooLarge(err) && !res.headersSent) {
        const hint =
          `Payload too large for the Hub (parser limit: ${jsonBodyLimitBytes} bytes; ` +
          `messages are limited to ${config.maxMessageBytes} bytes). ` +
          `Write the content to a file on disk and send the absolute path instead of the content.`;
        log.warn(
          `[hub] body over the parser limit rejected on ${req.method} ${req.path}.`,
        );
        if (req.path.startsWith("/mcp")) {
          res.status(413).json({
            jsonrpc: "2.0",
            error: { code: -32600, message: hint },
            id: null,
          });
        } else {
          res.status(413).json({ ok: false, error: hint });
        }
        return;
      }
      if (err instanceof SyntaxError && !res.headersSent) {
        log.warn(`[hub] malformed JSON body rejected on ${req.method} ${req.path}.`);
        if (req.path.startsWith("/mcp")) {
          res.status(400).json({
            jsonrpc: "2.0",
            error: { code: -32700, message: "Parse error" },
            id: null,
          });
        } else {
          res
            .status(400)
            .json({ ok: false, error: "Malformed JSON body (parse error)." });
        }
        return;
      }
      if (res.headersSent) {
        next(err);
        return;
      }
      log.error(`[hub] unhandled error on ${req.method} ${req.path}:`, err);
      res.status(500).json({ ok: false, error: "Internal Hub error." });
    },
  );

  // D6 (non-negotiable): bind EXCLUSIVELY on 127.0.0.1 via BIND_HOST —
  // hard-coded in config.ts, never configurable. Exposing this port on the
  // network would hand out remote code execution (messages become agent input).
  const server = app.listen(port, BIND_HOST);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const effectivePort = (server.address() as AddressInfo).port;
  const url = `http://${BIND_HOST}:${effectivePort}`;

  // Phase 3: flush (5s) + status polling timers live and die with the hub.
  dispatcher?.start();

  log.info(`Switchboard Hub up at ${url} (version ${version}).`);
  log.info(`Dashboard:    ${url}/`);
  log.info(`MCP endpoint: ${url}/mcp`);
  log.info(`REST + SSE:   ${url}/api`);
  log.info(`Data at:      ${baseDir}`);
  log.info(
    `Register in Claude Code (once, user scope): ` +
      `claude mcp add --transport http --scope user switchboard ${url}/mcp`,
  );

  let closed = false;
  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    log.info(`[hub] shutting down…`);
    dispatcher?.stop();
    launcher?.stop(); // cancel pending kickoff timers/polls
    await mcp.close();
    const serverClosed = new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    // Destroys keep-alive sockets and open SSE streams (/api/events) that
    // would otherwise keep server.close() pending forever.
    server.closeAllConnections();
    await serverClosed;
    log.info(`[hub] shut down.`);
  }

  return {
    port: effectivePort,
    url,
    baseDir,
    config,
    store,
    log,
    close,
  };
}
