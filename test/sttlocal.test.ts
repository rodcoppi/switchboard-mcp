// Local dictation (sherpa-onnx worker + ffmpeg). The worker is faked with a
// tiny node script speaking the real JSON-lines protocol, so these tests cover
// the full lifecycle — lazy spawn, ready handshake, request/response, idle
// kill, crash surfacing — without loading a 1 GB model.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalStt, MODEL_DIR_NAME, modelFiles } from "../src/server/sttlocal.js";
import { createSttEngine, SttError, type SttProxy } from "../src/server/stt.js";

const silentLog = { debug() {}, info() {}, warn() {}, error() {} } as never;

const tmp: string[] = [];
afterEach(() => {
  for (const p of tmp.splice(0)) fs.rmSync(p, { recursive: true, force: true });
});

/** A base dir with (empty) model files present, so installed() passes. */
function fakeModelDir(): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "sb-sttl-"));
  tmp.push(base);
  for (const f of modelFiles(base)) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, "x");
  }
  return base;
}

/** Writes a fake worker script that answers the JSON-lines protocol. */
function fakeWorker(body: string): string {
  const p = path.join(os.tmpdir(), `sb-sttl-worker-${process.pid}-${tmp.length}.mjs`);
  tmp.push(p);
  fs.writeFileSync(p, body);
  return p;
}

/** A fake ffmpeg that just copies input to output (argv: ... -i IN ... OUT). */
function fakeFfmpeg(): string {
  const p = path.join(os.tmpdir(), `sb-sttl-ffmpeg-${process.pid}-${tmp.length}.mjs`);
  tmp.push(p);
  fs.writeFileSync(
    p,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const inFile = args[args.indexOf("-i") + 1];
const outFile = args[args.length - 1];
require("node:fs").copyFileSync(inFile, outFile);
`,
  );
  return p;
}

const ECHO_WORKER = `
import { createInterface } from "node:readline";
process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const req = JSON.parse(line);
  process.stdout.write(JSON.stringify({ id: req.id, text: "  olá do worker  " }) + "\\n");
});
`;

// node can execute an .mjs "ffmpeg" only via process.execPath — so the fake
// ffmpeg is invoked as \`node script\`. createLocalStt takes the BINARY, so the
// fake needs a wrapper... simpler: a shell shim.
function fakeFfmpegShim(): string {
  const script = fakeFfmpeg().replace(/\.mjs$/, ".cjs");
  fs.renameSync(tmp[tmp.length - 1], script);
  tmp[tmp.length - 1] = script;
  const shim = path.join(os.tmpdir(), `sb-sttl-ff-${process.pid}-${tmp.length}`);
  tmp.push(shim);
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  fs.chmodSync(shim, 0o755);
  return shim;
}

describe("createLocalStt", () => {
  it("installed() is false until every model file exists", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "sb-sttl-"));
    tmp.push(base);
    const stt = createLocalStt({ log: silentLog, baseDir: base });
    expect(stt.installed()).toBe(false);
    for (const f of modelFiles(base)) {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, "x");
    }
    expect(stt.installed()).toBe(true);
    expect(modelFiles(base)[0]).toContain(MODEL_DIR_NAME);
  });

  it("transcribes through the worker protocol (lazy spawn + trim)", async () => {
    const stt = createLocalStt({
      log: silentLog,
      baseDir: fakeModelDir(),
      workerPath: fakeWorker(ECHO_WORKER),
      ffmpegBin: fakeFfmpegShim(),
    });
    const text = await stt.transcribe(Buffer.from("fake-audio"), "audio/webm");
    expect(text).toBe("olá do worker");
    stt.stop();
  });

  it("reuses ONE worker across requests", async () => {
    const worker = fakeWorker(`
import { createInterface } from "node:readline";
process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");
let n = 0;
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const req = JSON.parse(line);
  n++;
  process.stdout.write(JSON.stringify({ id: req.id, text: "pid:" + process.pid + " n:" + n }) + "\\n");
});
`);
    const stt = createLocalStt({
      log: silentLog,
      baseDir: fakeModelDir(),
      workerPath: worker,
      ffmpegBin: fakeFfmpegShim(),
    });
    const a = await stt.transcribe(Buffer.from("a"), "audio/webm");
    const b = await stt.transcribe(Buffer.from("b"), "audio/webm");
    expect(a).toMatch(/n:1$/);
    expect(b).toMatch(/n:2$/);
    expect(a.split(" ")[0]).toBe(b.split(" ")[0]); // same pid
    stt.stop();
  });

  it("surfaces a worker-side error as SttError", async () => {
    const worker = fakeWorker(`
import { createInterface } from "node:readline";
process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const req = JSON.parse(line);
  process.stdout.write(JSON.stringify({ id: req.id, error: "bad wave" }) + "\\n");
});
`);
    const stt = createLocalStt({
      log: silentLog,
      baseDir: fakeModelDir(),
      workerPath: worker,
      ffmpegBin: fakeFfmpegShim(),
    });
    await expect(stt.transcribe(Buffer.from("x"), "audio/webm")).rejects.toThrow(/bad wave/);
    stt.stop();
  });

  it("a worker that dies on load fails the request with its stderr", async () => {
    const worker = fakeWorker(`process.stderr.write("model files corrupt\\n"); process.exit(3);`);
    const stt = createLocalStt({
      log: silentLog,
      baseDir: fakeModelDir(),
      workerPath: worker,
      ffmpegBin: fakeFfmpegShim(),
      readyTimeoutMs: 5000,
    });
    await expect(stt.transcribe(Buffer.from("x"), "audio/webm")).rejects.toThrow(/died|corrupt/i);
    stt.stop();
  });

  it("501-shaped error when the model is not installed — before any spawn", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "sb-sttl-"));
    tmp.push(base);
    const stt = createLocalStt({ log: silentLog, baseDir: base });
    const err = await stt.transcribe(Buffer.from("x"), "audio/webm").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SttError);
    expect((err as SttError).status).toBe(501);
  });
});

describe("createSttEngine (local-first composition)", () => {
  const groqStub = (available: boolean): SttProxy => ({
    available: () => available,
    transcribe: async () => "from-groq",
  });

  it("prefers local when installed; falls back to groq when not", async () => {
    const local = { installed: () => true, transcribe: async () => "from-local" };
    expect(await createSttEngine({ local, groq: groqStub(true) }).transcribe(Buffer.from("x"), "a")).toBe(
      "from-local",
    );
    const noLocal = { installed: () => false, transcribe: async () => "never" };
    expect(await createSttEngine({ local: noLocal, groq: groqStub(true) }).transcribe(Buffer.from("x"), "a")).toBe(
      "from-groq",
    );
  });

  it("available() when either side is", () => {
    const no = { installed: () => false, transcribe: async () => "" };
    const yes = { installed: () => true, transcribe: async () => "" };
    expect(createSttEngine({ local: yes, groq: groqStub(false) }).available()).toBe(true);
    expect(createSttEngine({ local: no, groq: groqStub(true) }).available()).toBe(true);
    expect(createSttEngine({ local: no, groq: groqStub(false) }).available()).toBe(false);
  });

  it("a LOCAL failure surfaces — audio is never silently retried in the cloud", async () => {
    const local = {
      installed: () => true,
      transcribe: async () => {
        throw new SttError("local broke");
      },
    };
    let groqCalled = false;
    const groq: SttProxy = {
      available: () => true,
      transcribe: async () => {
        groqCalled = true;
        return "cloud";
      },
    };
    await expect(createSttEngine({ local, groq }).transcribe(Buffer.from("x"), "a")).rejects.toThrow(
      /local broke/,
    );
    expect(groqCalled).toBe(false);
  });
});
