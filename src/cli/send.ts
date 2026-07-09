// `switchboard send <to> <message...>` (PRD section 11): sends as "operator"
// via POST /api/messages — the REST layer fixes from="operator"; the CLI
// never claims an agent identity. Prints the delivery outcome; hub errors
// (unknown recipient, oversized body) surface verbatim — they are already
// written in Portuguese for the reader to self-correct.

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
      return "nudge disparado no terminal do agente";
    case "coalesced":
      return "nudge coalescido (cooldown ativo) — o agente será cutucado em breve";
    case "queued_offline":
      return "gravada na fila — agente offline, lerá via check_messages ao voltar";
    case "queued_muted":
      return "gravada na fila — agente silenciado (mute), nudge suprimido";
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
  await checkHubHealth(hubUrl); // hub down → clear "serve primeiro" error
  const result = await hubPost<SendResponse>(hubUrl, "/api/messages", {
    to: options.to,
    body: options.message,
  });
  const recipients =
    options.to === "all" ? ` (broadcast para ${result.messages.length} agente(s))` : "";
  out(`Mensagem enviada como operator para "${options.to}"${recipients}.`);
  out(`Delivery: ${result.delivery} — ${describeDelivery(result.delivery)}.`);
  return result;
}

export function registerSendCommand(program: Command): void {
  program
    .command("send")
    .description(`Envia uma mensagem como "operator" para um agente (ou "all" para broadcast).`)
    .argument("<to>", `nome do agente destinatário, ou "all"`)
    .argument("<message...>", "texto da mensagem")
    .action(async (to: string, messageParts: string[]) => {
      await runCliAction(() =>
        runSend({ to, message: messageParts.join(" ") }).then(() => undefined),
      );
    });
}
