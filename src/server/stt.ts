// Speech-to-text proxy — the dictation mic's transcription backend.
//
// The mic used to ride Chrome's Web Speech API, which does NOT transcribe
// locally: the browser ships the audio to Google's speech service, and when
// that endpoint is unreachable (adblock DNS lists, VPNs, some networks) the
// feature is simply dead — the owner hit exactly that ("speech service
// unreachable"). So the dashboard now records audio itself (MediaRecorder) and
// POSTs it to the hub, and the hub transcribes through Groq's Whisper API.
//
// Same shape and rules as the usage probe (usage.ts), the one other outbound
// call this hub makes: native fetch only (no new dependency — FormData/Blob
// are built into Node 20), the key never leaves this process, and any failure
// degrades to a clear in-protocol error, never a crash. The audio goes to
// Groq and nowhere else, only when the operator explicitly records.
//
// Key resolution: $GROQ_API_KEY, else ~/.config/watch/.env (the owner already
// keeps the key there for another tool — reusing it beats asking them to
// configure the same secret twice). No key → the /api/stt route answers 501
// with instructions.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "./log.js";

/** Groq's own per-file limit; the route's raw-body limit mirrors it. */
export const MAX_STT_BYTES = 25 * 1024 * 1024;

const STT_ENDPOINT = "https://api.groq.com/openai/v1/audio/transcriptions";
const STT_MODEL = "whisper-large-v3-turbo";

export class SttError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
    this.name = "SttError";
  }
}

/** Default location of the watch tool's env file (injectable for tests). */
export function watchEnvPath(): string {
  return path.join(os.homedir(), ".config", "watch", ".env");
}

/**
 * Pulls VAR=value out of a dotenv-style file: comments and blanks skipped,
 * optional single/double quotes stripped, first match wins. Null when the
 * file is missing or the var is not in it — never throws.
 */
export function readEnvFileVar(filePath: string, name: string): string | null {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || m[1] !== name) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    return v === "" ? null : v;
  }
  return null;
}

/** The Groq key, or null: process env first, then the watch tool's .env. */
export function resolveGroqKey(
  env: NodeJS.ProcessEnv = process.env,
  envFile: string = watchEnvPath(),
): string | null {
  const fromEnv = env.GROQ_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  return readEnvFileVar(envFile, "GROQ_API_KEY");
}

export interface SttProxy {
  /** Whether a key is configured (drives the route's 501). */
  available(): boolean;
  /** Transcribes one audio blob; throws SttError with a useful message. */
  transcribe(audio: Buffer, mime: string): Promise<string>;
}

export interface SttOptions {
  log: Logger;
  env?: NodeJS.ProcessEnv;
  envFile?: string;
  endpoint?: string;
  model?: string;
  fetchFn?: typeof fetch;
}

export function createSttProxy(options: SttOptions): SttProxy {
  const { log } = options;
  const endpoint = options.endpoint ?? STT_ENDPOINT;
  const model = options.model ?? STT_MODEL;
  const fetchFn = options.fetchFn ?? fetch;
  // Resolved per call, not cached at boot: the owner can add the key and
  // retry without restarting the hub.
  const key = () => resolveGroqKey(options.env ?? process.env, options.envFile ?? watchEnvPath());

  return {
    available(): boolean {
      return key() !== null;
    },

    async transcribe(audio: Buffer, mime: string): Promise<string> {
      const k = key();
      if (!k) throw new SttError("No GROQ_API_KEY configured.", 501);
      if (audio.length === 0) throw new SttError("Empty audio.", 400);
      if (audio.length > MAX_STT_BYTES) {
        throw new SttError(`Audio too large (${audio.length} bytes; limit ${MAX_STT_BYTES}).`, 413);
      }
      // Groq wants multipart; the filename's extension is how the server picks
      // a decoder, so derive it from the MIME the recorder actually produced.
      const ext = /ogg/.test(mime) ? "ogg" : /mp4|m4a|aac/.test(mime) ? "mp4" : /wav/.test(mime) ? "wav" : "webm";
      const form = new FormData();
      form.append("model", model);
      form.append("response_format", "json");
      // Language deliberately omitted: Whisper autodetects, and the operator
      // dictates in pt-BR and English interchangeably.
      form.append("file", new Blob([new Uint8Array(audio)], { type: mime || "audio/webm" }), `audio.${ext}`);

      let res: Response;
      try {
        res = await fetchFn(endpoint, {
          method: "POST",
          headers: { Authorization: `Bearer ${k}` },
          body: form,
        });
      } catch (err) {
        throw new SttError(
          `Could not reach the transcription service (${err instanceof Error ? err.message : err}).`,
        );
      }
      if (!res.ok) {
        // Groq's error body is JSON with a useful message — surface it, but
        // never echo anything that could carry the key.
        let detail = `HTTP ${res.status}`;
        try {
          const body = (await res.json()) as { error?: { message?: string } };
          if (body.error?.message) detail = `${detail}: ${body.error.message}`;
        } catch {
          /* non-JSON error body — the status alone will do */
        }
        log.warn(`[stt] transcription failed: ${detail}`);
        throw new SttError(`Transcription failed (${detail}).`);
      }
      const body = (await res.json()) as { text?: unknown };
      return typeof body.text === "string" ? body.text.trim() : "";
    },
  };
}
