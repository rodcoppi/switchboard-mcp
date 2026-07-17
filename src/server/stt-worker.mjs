#!/usr/bin/env node
// Local transcription worker — a child process the hub spawns on demand.
//
// Loads the sherpa-onnx recognizer ONCE (the expensive part: ~1 GB of int8
// ONNX weights) and then answers JSON lines over stdio:
//   in : {"id": 1, "wav": "/abs/path.wav"}          (16 kHz mono PCM wav)
//   out: {"id": 1, "text": "..."} | {"id": 1, "error": "..."}
// A {"type":"ready"} line signals the model finished loading. The process
// lives until stdin closes (the parent kills it after an idle window so the
// weights don't sit in RAM forever). Mirrors the proven shape of the
// reference app's speech worker (claudinei), minus its packaging shims.
//
// Plain .mjs, no TypeScript: the hub spawns it with bare `node`, and keeping
// the worker dependency-free avoids dragging tsx into a child process.

import { createInterface } from "node:readline";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sherpa = require("sherpa-onnx-node");

const dir = process.env.SPEECH_MODEL_DIR;
if (!dir) {
  process.stderr.write("SPEECH_MODEL_DIR not set\n");
  process.exit(1);
}

const recognizer = new sherpa.OfflineRecognizer({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: {
    transducer: {
      encoder: join(dir, "encoder.int8.onnx"),
      decoder: join(dir, "decoder.int8.onnx"),
      joiner: join(dir, "joiner.int8.onnx"),
    },
    tokens: join(dir, "tokens.txt"),
    numThreads: 4, // half the cores: dictation is bursty, agents keep running
    provider: "cpu",
    modelType: "nemo_transducer",
  },
});

process.stdout.write(JSON.stringify({ type: "ready" }) + "\n");

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return; // half line / garbage — ignore, never die
  }
  try {
    const wave = sherpa.readWave(req.wav);
    const stream = recognizer.createStream();
    stream.acceptWaveform({ samples: wave.samples, sampleRate: wave.sampleRate });
    recognizer.decode(stream);
    const text = recognizer.getResult(stream).text ?? "";
    process.stdout.write(JSON.stringify({ id: req.id, text }) + "\n");
  } catch (err) {
    process.stdout.write(
      JSON.stringify({ id: req.id, error: err && err.message ? err.message : String(err) }) + "\n",
    );
  }
});
