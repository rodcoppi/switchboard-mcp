// Shared data models for Switchboard.
// Source of truth: PRD-switchboard.md — sections 7 (config), 8 (data models)
// and 10.1 (SSE events). Keep these types in sync with the PRD.

export type AgentStatus = "online" | "offline";

export interface Agent {
  name: string; // ^[a-z0-9][a-z0-9-]{1,30}$ , unique
  role: string; // free-form description, e.g. "backend da API de pagamentos"
  tmuxSession: string; // e.g. "sb-alpha" (prefix + name)
  cwd: string; // directory where claude was opened
  status: AgentStatus; // derived from tmux has-session during polling
  mcpConnected: boolean; // true after the first join via MCP
  muted: boolean; // dashboard can silence nudges (messages are still recorded)
  createdAt: string; // ISO 8601
  lastSeenAt: string; // last MCP interaction or last positive polling
  lastNudgeAt: string | null;
}

export interface Message {
  id: string; // ULID
  from: string; // agent name | "operator"
  to: string; // agent name | "all"
  body: string; // plain text, <= maxMessageBytes
  createdAt: string; // ISO 8601
  readAt: string | null; // filled when check_messages delivers
  // For to === "all": the message is expanded into N records, one per recipient,
  // sharing the same broadcastId for tracking. The expansion is done by the
  // caller (hub/MCP layer), NOT by the store.
  broadcastId: string | null;
}

// ---------------------------------------------------------------------------
// Configuration (PRD section 7). Every key has a default; the config file
// (~/.switchboard/config.json) may not exist at all.
// ---------------------------------------------------------------------------

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Config {
  port: number; // default 4577
  tmuxSessionPrefix: string; // default "sb-"
  nudgeCooldownMs: number; // default 15000
  nudgeEnterDelayMs: number; // default 500
  pairRateLimitPerMinute: number; // default 12
  maxMessageBytes: number; // default 16384
  kickoffDelayMs: number; // default 8000
  agentPollIntervalMs: number; // default 10000
  logLevel: LogLevel; // default "info"
}

// ---------------------------------------------------------------------------
// SSE events streamed on GET /api/events (PRD section 10.1).
// {type: agent_updated|message_created|message_read|nudge_sent, payload}
// ---------------------------------------------------------------------------

export interface AgentUpdatedEvent {
  type: "agent_updated";
  payload: Agent;
}

export interface MessageCreatedEvent {
  type: "message_created";
  payload: Message;
}

export interface MessageReadEvent {
  type: "message_read";
  // Mirrors the JSONL read event appended by the store.
  payload: { messageId: string; readAt: string };
}

export interface NudgeSentEvent {
  type: "nudge_sent";
  payload: { agent: string; at: string; unread: number };
}

export type SseEvent =
  | AgentUpdatedEvent
  | MessageCreatedEvent
  | MessageReadEvent
  | NudgeSentEvent;
