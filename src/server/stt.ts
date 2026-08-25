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
  /**
   * `language`: an ISO-639-1 code from the CALLER — the dashboard sends the
   * browser's own locale, which is the closest thing to "the language the
   * person at the microphone is speaking" that this hub can know.
   */
  transcribe(audio: Buffer, mime: string, language?: string): Promise<string>;
}

/**
 * The engine the /api/stt route actually talks to: LOCAL first (sherpa-onnx —
 * no cloud, no key, no bill; the owner's requirement), the Groq proxy only as
 * a fallback for a machine without the model. A local failure is surfaced,
 * never silently retried in the cloud — audio leaves this machine only when
 * local transcription is not installed at all.
 */
/**
 * Which backend transcribes:
 *   "auto"  — local model if installed, cloud otherwise (the default, and what
 *             this hub has always done);
 *   "local" — local only; no audio ever leaves the machine, and a missing
 *             model is an error rather than a silent trip to the cloud;
 *   "cloud" — cloud only, which is the accurate one for pt-BR: the local model
 *             here is a 0.6B int8 multilingual (fast, small, and it shows).
 * The point of the knob is that this is a TASTE call — privacy against
 * accuracy — and it belongs to whoever is speaking, not to a default.
 */
export type SttEngineChoice = "auto" | "local" | "cloud";

export function createSttEngine(deps: {
  local: { installed(): boolean; transcribe(audio: Buffer, mime: string): Promise<string> };
  groq: SttProxy;
  engine?: SttEngineChoice;
}): SttProxy {
  const choice: SttEngineChoice = deps.engine ?? "auto";
  const useLocal = () => choice !== "cloud" && deps.local.installed();
  return {
    available(): boolean {
      if (choice === "local") return deps.local.installed();
      if (choice === "cloud") return deps.groq.available();
      return deps.local.installed() || deps.groq.available();
    },
    async transcribe(audio: Buffer, mime: string, language?: string): Promise<string> {
      // The local engine is single-language by construction (the model on disk
      // decides), so the hint only means something to the cloud one.
      if (useLocal()) return deps.local.transcribe(audio, mime);
      if (choice === "local") {
        throw new SttError(
          "Local dictation is selected but its model is not installed " +
            "(sttEngine=\"local\" in ~/.switchboard/config.json).",
          501,
        );
      }
      return deps.groq.transcribe(audio, mime, language);
    },
  };
}

export interface SttOptions {
  log: Logger;
  env?: NodeJS.ProcessEnv;
  envFile?: string;
  endpoint?: string;
  model?: string;
  fetchFn?: typeof fetch;
  /** ISO-639-1 code forced on every take; "" disables (back to autodetect). */
  language?: string;
  /** Vocabulary hint sent with each take; "" disables. */
  prompt?: string;
}

/**
 * Words a dictation of THIS project keeps producing, spelled the way they
 * should land. Whisper treats the prompt as "text that came just before", so
 * it both fixes these spellings and anchors the language of the reading.
 */
export const DEFAULT_STT_PROMPT =
  "Switchboard, tmux, WSL, hub, dashboard, agente, commit, deploy, log, prompt, " +
  "Claude Code, Codex, MCP, nudge, token, branch, pull request.";

/**
 * The language to transcribe in: an explicit override, else the system's own
 * locale ("pt_BR.UTF-8" → "pt"), else nothing (autodetect). Deriving it from
 * the locale keeps this correct for anyone who installs the project without
 * making them configure a second place — the machine already says which
 * language its owner speaks. Exported for direct unit testing.
 */
export function sttLanguage(env: NodeJS.ProcessEnv, override?: string): string | null {
  if (typeof override === "string") return override.trim() === "" ? null : override.trim();
  const raw = env.LC_ALL || env.LC_MESSAGES || env.LANG || "";
  const m = /^([A-Za-z]{2})(?:[_-][A-Za-z]{2})?/.exec(raw.trim());
  if (!m) return null;
  const code = m[1].toLowerCase();
  return code === "c" ? null : code; // LANG=C is "no locale", not Catalan
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

    async transcribe(audio: Buffer, mime: string, language?: string): Promise<string> {
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
      // LANGUAGE, and this one is load-bearing. It was deliberately omitted so
      // Whisper could autodetect, on the theory that the operator switches
      // between pt-BR and English — but detection reads the FIRST seconds, and
      // a false start ("é… então") or a bit of room noise is enough to pick
      // the wrong one. From there the whole take comes back mangled, sometimes
      // translated rather than transcribed (23/08: "falei um monte de coisa
      // veio tudo errado"). Naming the language costs one field and removes
      // the entire failure mode.
      const lang = sttLanguage(options.env ?? process.env, options.language ?? language);
      if (lang) form.append("language", lang);
      // Deterministic: dictation wants the same words back, not a paraphrase.
      form.append("temperature", "0");
      // The prompt is Whisper's vocabulary hint — it fixes the spelling of the
      // names this operator says every day AND anchors the language, since a
      // Portuguese prompt makes a Portuguese reading far more likely.
      const hint = options.prompt ?? DEFAULT_STT_PROMPT;
      if (hint) form.append("prompt", hint);
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
