// Local speech-to-text — the dictation engine that runs ON THIS MACHINE.
//
// The owner's requirement, verbatim: no cloud, no key, no bill. This mirrors
// the approach proven in the reference app (claudinei): sherpa-onnx running
// NVIDIA's Parakeet TDT 0.6B v3 (int8 ONNX, multilingual — pt-BR included) on
// CPU. The audio never leaves the machine.
//
// Shape:
//   browser (MediaRecorder, webm/opus)
//     -> POST /api/stt (raw bytes)
//     -> ffmpeg: webm -> 16 kHz mono wav          (ffmpeg is a system prereq)
//     -> stt-worker.mjs (child process, JSON lines; loads the model ONCE)
//     -> text
//
// The worker is spawned LAZILY on the first dictation and killed after an
// idle window: the weights cost ~1 GB of RAM, and this box runs a whole agent
// fleet — the model only occupies memory while dictation is actually in use.
//
// Model files live in ~/.switchboard/speech/<MODEL_DIR_NAME>; installed() just
// checks they exist. Missing model → the caller falls back (Groq, or a 501
// that says exactly what to download).

import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import type { Logger } from "./log.js";
import { SttError } from "./stt.js";

const execFileAsync = promisify(execFile);

export const MODEL_DIR_NAME = "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8";

/** Where the speech model lives (CLI + docs reference this). */
export function speechDir(): string {
  return path.join(os.homedir(), ".switchboard", "speech");
}

/** The model files sherpa needs; installed() checks all of them. */
export function modelFiles(baseDir: string): string[] {
  const dir = path.join(baseDir, MODEL_DIR_NAME);
  return [
    path.join(dir, "encoder.int8.onnx"),
    path.join(dir, "decoder.int8.onnx"),
    path.join(dir, "joiner.int8.onnx"),
    path.join(dir, "tokens.txt"),
  ];
}

export interface LocalStt {
  installed(): boolean;
  transcribe(audio: Buffer, mime: string): Promise<string>;
  /** Kills the worker if running (hub shutdown). */
  stop(): void;
}

export interface LocalSttOptions {
  log: Logger;
  baseDir?: string;
  /** Worker script override (tests use a fake that answers canned text). */
  workerPath?: string;
  ffmpegBin?: string;
  /** Idle window before the worker is killed to free the model's RAM. */
  idleMs?: number;
  readyTimeoutMs?: number;
  requestTimeoutMs?: number;
}

interface Pending {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export function createLocalStt(options: LocalSttOptions): LocalStt {
  const { log } = options;
  const baseDir = options.baseDir ?? speechDir();
  const workerPath =
    options.workerPath ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "stt-worker.mjs");
  const ffmpegBin = options.ffmpegBin ?? "ffmpeg";
  const idleMs = options.idleMs ?? 5 * 60_000;
  const readyTimeoutMs = options.readyTimeoutMs ?? 30_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;

  let worker: ChildProcess | null = null;
  let ready: Promise<void> | null = null;
  let idleTimer: NodeJS.Timeout | null = null;
  let nextId = 1;
  const pending = new Map<number, Pending>();

  function killWorker(reason: string): void {
    if (!worker) return;
    log.info(`[stt-local] worker stopped (${reason}).`);
    worker.kill();
    worker = null;
    ready = null;
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new SttError("Transcription worker stopped mid-request."));
    }
    pending.clear();
  }

  function touchIdle(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => killWorker("idle"), idleMs);
    idleTimer.unref?.();
  }

  /** Spawns the worker (once) and resolves when the model is loaded. */
  function ensureWorker(): Promise<void> {
    if (worker && ready) return ready;
    const modelDir = path.join(baseDir, MODEL_DIR_NAME);
    log.info(`[stt-local] loading model (first dictation since idle)…`);
    const child = spawn(process.execPath, [workerPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        SPEECH_MODEL_DIR: modelDir,
        // The sherpa native module's .so neighbours resolve via $ORIGIN; adding
        // the package dir is a belt-and-braces for setups where they don't.
        LD_LIBRARY_PATH: [
          path.join(process.cwd(), "node_modules", "sherpa-onnx-linux-x64"),
          process.env.LD_LIBRARY_PATH ?? "",
        ].join(":"),
      },
    });
    worker = child;

    const rl = createInterface({ input: child.stdout! });
    let markReady: (() => void) | null = null;
    let failReady: ((err: Error) => void) | null = null;
    ready = new Promise<void>((resolve, reject) => {
      markReady = resolve;
      failReady = reject;
      const t = setTimeout(
        () => reject(new SttError(`Transcription model did not load within ${readyTimeoutMs}ms.`)),
        readyTimeoutMs,
      );
      t.unref?.();
    });

    let stderrTail = "";
    child.stderr!.on("data", (d: Buffer) => {
      stderrTail = (stderrTail + d.toString()).slice(-600);
    });
    rl.on("line", (line) => {
      let msg: { type?: string; id?: number; text?: string; error?: string };
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.type === "ready") {
        log.info(`[stt-local] model loaded.`);
        markReady?.();
        return;
      }
      if (typeof msg.id !== "number") return;
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (typeof msg.error === "string") p.reject(new SttError(`Transcription failed (${msg.error}).`));
      else p.resolve((msg.text ?? "").trim());
    });
    child.on("exit", (code) => {
      const alive = worker === child;
      if (alive) {
        // Unexpected death (a clean stop() nulls `worker` first).
        failReady?.(
          new SttError(
            `Transcription worker died (exit ${code}). ${stderrTail ? `Last stderr: ${stderrTail}` : ""}`,
          ),
        );
        killWorker(`exit ${code}`);
      }
    });
    return ready;
  }

  return {
    installed(): boolean {
      return modelFiles(baseDir).every((f) => fs.existsSync(f));
    },

    async transcribe(audio: Buffer, mime: string): Promise<string> {
      if (!this.installed()) throw new SttError("Local speech model not installed.", 501);
      if (audio.length === 0) throw new SttError("Empty audio.", 400);

      // webm/opus (or whatever the recorder produced) -> 16 kHz mono wav, via
      // temp files: sherpa reads a wav PATH, and ffmpeg's stdin pipe handling
      // of webm is flaky — files are boring and reliable.
      const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const tmpIn = path.join(os.tmpdir(), `sb-stt-${stamp}.in`);
      const tmpWav = path.join(os.tmpdir(), `sb-stt-${stamp}.wav`);
      fs.writeFileSync(tmpIn, audio);
      try {
        try {
          await execFileAsync(ffmpegBin, [
            "-hide_banner", "-loglevel", "error",
            "-i", tmpIn,
            "-ar", "16000", "-ac", "1", "-f", "wav",
            "-y", tmpWav,
          ]);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          throw new SttError(
            code === "ENOENT"
              ? "ffmpeg not found — local dictation needs it (apt/brew install ffmpeg)."
              : `Could not decode the recording (${(err as Error).message.slice(0, 200)}).`,
          );
        }

        await ensureWorker();
        touchIdle();
        const id = nextId++;
        const text = await new Promise<string>((resolve, reject) => {
          const timer = setTimeout(
            () => {
              pending.delete(id);
              reject(new SttError(`Transcription timed out (${requestTimeoutMs}ms).`));
            },
            requestTimeoutMs,
          );
          timer.unref?.();
          pending.set(id, { resolve, reject, timer });
          worker!.stdin!.write(JSON.stringify({ id, wav: tmpWav }) + "\n");
        });
        return text;
      } finally {
        fs.rmSync(tmpIn, { force: true });
        fs.rmSync(tmpWav, { force: true });
      }
    },

    stop(): void {
      if (idleTimer) clearTimeout(idleTimer);
      killWorker("hub shutdown");
    },
  };
}
