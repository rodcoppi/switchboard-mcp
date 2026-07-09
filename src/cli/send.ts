// `switchboard send <to> <message...>` (PRD section 11): sends as "operator"
// via POST /api/messages — the REST layer fixes from="operator"; the CLI
// never claims an agent identity. Prints the delivery outcome; hub errors
// (unknown recipient, oversized body) surface verbatim — they are already
// written in English for the reader to self-correct.

import type { Command } from "commander";
import type { Delivery, Message } from "../shared/types.js";
import {
  checkHubHealth,
  defaultHubUrl,
  hubPost,
  runCliAction,
  type OutFn,
} from "./common.js";

/** Human explanation of each delivery outcome (PRD 9.2 values). */
export function describeDelivery(delivery: Delivery): string {
  switch (delivery) {
    case "nudged":
      return "nudge fired in the agent's terminal";
    case "coalesced":
      return "nudge coalesced (cooldown active) — the agent will be nudged soon";
    case "queued_offline":
      return "queued — agent offline, will read via check_messages when it returns";
    case "queued_muted":
      return "queued — agent muted, nudge suppressed";
  }
}

interface SendResponse {
  ok: boolean;
  delivery: Delivery;
  messages: Message[];
  broadcastId: string | null;
}

export interface SendOptions {
  to: string;
  message: string;
  hubUrl?: string;
  baseDir?: string;
  out?: OutFn;
}

export async function runSend(options: SendOptions): Promise<SendResponse> {
  const out = options.out ?? console.log;
  const hubUrl = options.hubUrl ?? defaultHubUrl(options.baseDir);
  await checkHubHealth(hubUrl); // hub down → clear "serve first" error
  const result = await hubPost<SendResponse>(hubUrl, "/api/messages", {
    to: options.to,
    body: options.message,
  });
  const recipients =
    options.to === "all" ? ` (broadcast to ${result.messages.length} agent(s))` : "";
  out(`Message sent as operator to "${options.to}"${recipients}.`);
  out(`Delivery: ${result.delivery} — ${describeDelivery(result.delivery)}.`);
  return result;
}

export function registerSendCommand(program: Command): void {
  program
    .command("send")
    .description(`Sends a message as "operator" to an agent (or "all" for broadcast).`)
    .argument("<to>", `recipient agent name, or "all"`)
    .argument("<message...>", "message text")
    .action(async (to: string, messageParts: string[]) => {
      await runCliAction(() =>
        runSend({ to, message: messageParts.join(" ") }).then(() => undefined),
      );
    });
}
