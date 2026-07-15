// `switchboard status` (PRD section 11): terminal table with
// NAME | ROLE | STATUS | MCP | UNREAD | LAST SEEN, sourced from
// GET /api/agents. Clear error when the hub is down.

import type { Command } from "commander";
import { resolveGroup } from "../server/store.js";
import {
  checkHubHealth,
  defaultHubUrl,
  formatRelative,
  hubGet,
  runCliAction,
  type OutFn,
} from "./common.js";

/**
 * Row shape consumed by the formatter (subset of PublicAgent + unreadCount).
 * tmuxSession is not displayed here, but stop/down consume it as the
 * REGISTERED session name (source of truth — never recomputed prefix+name).
 */
export interface StatusRow {
  name: string;
  /** Absent = a record written before groups existed; it reads as DEFAULT_GROUP. */
  group?: string;
  role: string;
  status: string;
  mcpConnected: boolean;
  unreadCount: number;
  lastSeenAt: string;
  tmuxSession: string;
}

// GROUP sits right after NAME: it is the answer to "who does this one talk to",
// which is the second thing you ask about an agent and, since groups are a wall,
// the difference between "quiet" and "cannot reach anyone".
const HEADERS = ["NAME", "GROUP", "ROLE", "STATUS", "MCP", "UNREAD", "LAST SEEN"] as const;
const MAX_ROLE_WIDTH = 40;

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

/**
 * Clean fixed-width table (two-space gutters, headers per PRD 11), rows
 * sorted by name for stable output. lastSeen rendered relative ("2min
 * ago"). Pure — unit-tested with fake data and an injected clock. Extra
 * fields on the input objects are ignored by construction (only the six
 * columns are ever read), so nothing beyond the PublicAgent view can leak.
 */
export function formatStatusTable(rows: StatusRow[], nowMs: number = Date.now()): string {
  if (rows.length === 0) {
    return `No registered agents. Use "switchboard start <name>" to create the first one.`;
  }
  const cells = [...rows]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((row) => [
      row.name,
      resolveGroup(row.group),
      truncate(row.role === "" ? "—" : row.role, MAX_ROLE_WIDTH),
      row.status,
      row.mcpConnected ? "yes" : "no",
      String(row.unreadCount),
      formatRelative(row.lastSeenAt, nowMs),
    ]);
  const widths = HEADERS.map((header, i) =>
    Math.max(header.length, ...cells.map((row) => row[i].length)),
  );
  const renderLine = (row: readonly string[]): string =>
    row.map((cell, i) => cell.padEnd(widths[i])).join("  ").trimEnd();
  return [renderLine(HEADERS), ...cells.map(renderLine)].join("\n");
}

export interface StatusOptions {
  hubUrl?: string;
  baseDir?: string;
  out?: OutFn;
  now?: () => number;
}

export async function runStatus(options: StatusOptions = {}): Promise<void> {
  const out = options.out ?? console.log;
  const hubUrl = options.hubUrl ?? defaultHubUrl(options.baseDir);
  await checkHubHealth(hubUrl); // hub down → clear "serve first" error
  const agents = await hubGet<StatusRow[]>(hubUrl, "/api/agents");
  out(formatStatusTable(agents, (options.now ?? Date.now)()));
}

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Shows the agents registered in the Hub (status, MCP, unread, last seen).")
    .action(async () => {
      await runCliAction(() => runStatus());
    });
}
