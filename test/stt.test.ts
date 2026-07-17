// The dictation transcription proxy (POST /api/stt's engine). Fails closed:
// no key → a 501-shaped SttError with instructions, never a crash; the key is
// read from the environment or the watch tool's .env, never cached at boot.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_STT_BYTES,
  SttError,
  createSttProxy,
  readEnvFileVar,
  resolveGroqKey,
} from "../src/server/stt.js";

const silentLog = { debug() {}, info() {}, warn() {}, error() {} } as never;

const tmp: string[] = [];
function envFile(content: string | null): string {
  const p = path.join(os.tmpdir(), `sb-stt-${process.pid}-${tmp.length}.env`);
  if (content !== null) fs.writeFileSync(p, content);
  tmp.push(p);
  return p;
}
afterEach(() => {
  for (const p of tmp.splice(0)) fs.rmSync(p, { force: true });
});

describe("readEnvFileVar", () => {
  it("reads plain, quoted and exported values; skips comments", () => {
    const f = envFile(
      "# comment\nOTHER=x\nexport GROQ_API_KEY=\"gsk_abc\"\nTRAILING=1\n",
    );
    expect(readEnvFileVar(f, "GROQ_API_KEY")).toBe("gsk_abc");
    expect(readEnvFileVar(f, "OTHER")).toBe("x");
    expect(readEnvFileVar(f, "MISSING")).toBeNull();
  });

  it("null for a missing file and for an empty value", () => {
    expect(readEnvFileVar("/does/not/exist.env", "X")).toBeNull();
    expect(readEnvFileVar(envFile("GROQ_API_KEY=\n"), "GROQ_API_KEY")).toBeNull();
  });
});

describe("resolveGroqKey", () => {
  it("the process env wins over the file", () => {
    const f = envFile("GROQ_API_KEY=from-file\n");
    expect(resolveGroqKey({ GROQ_API_KEY: "from-env" } as NodeJS.ProcessEnv, f)).toBe("from-env");
  });
  it("falls back to the file, then to null", () => {
    const f = envFile("GROQ_API_KEY=from-file\n");
    expect(resolveGroqKey({} as NodeJS.ProcessEnv, f)).toBe("from-file");
    expect(resolveGroqKey({} as NodeJS.ProcessEnv, "/ghost.env")).toBeNull();
  });
});

describe("createSttProxy", () => {
  const okFetch = (onReq?: (url: string, init: RequestInit) => void, text = " olá mundo ") =>
    (async (url: string, init: RequestInit) => {
      onReq?.(url, init);
      return { ok: true, json: async () => ({ text }) } as Response;
    }) as unknown as typeof fetch;

  const proxy = (fetchFn: typeof fetch, key: string | null = "gsk_test") =>
    createSttProxy({
      log: silentLog,
      env: (key ? { GROQ_API_KEY: key } : {}) as NodeJS.ProcessEnv,
      envFile: "/ghost.env",
      fetchFn,
    });

  it("available() mirrors key presence", () => {
    expect(proxy(okFetch(), "k").available()).toBe(true);
    expect(proxy(okFetch(), null).available()).toBe(false);
  });

  it("sends multipart with the model + audio file and the bearer key", async () => {
    let seen: { url?: string; auth?: string; model?: string; fileName?: string; fileType?: string } = {};
    const p = proxy(
      okFetch((url, init) => {
        const form = init.body as FormData;
        const file = form.get("file") as File;
        seen = {
          url,
          auth: (init.headers as Record<string, string>).Authorization,
          model: String(form.get("model")),
          fileName: file.name,
          fileType: file.type,
        };
      }),
    );
    const text = await p.transcribe(Buffer.from("fake-webm-bytes"), "audio/webm;codecs=opus");
    expect(text).toBe("olá mundo"); // trimmed
    expect(seen.url).toContain("api.groq.com");
    expect(seen.auth).toBe("Bearer gsk_test");
    expect(seen.model).toBe("whisper-large-v3-turbo");
    expect(seen.fileName).toBe("audio.webm");
    expect(seen.fileType).toContain("audio/webm");
  });

  it("names the file by the MIME so the decoder matches (ogg/mp4/wav)", async () => {
    const names: string[] = [];
    const p = proxy(okFetch((_u, init) => names.push(((init.body as FormData).get("file") as File).name)));
    await p.transcribe(Buffer.from("x"), "audio/ogg");
    await p.transcribe(Buffer.from("x"), "audio/mp4");
    await p.transcribe(Buffer.from("x"), "audio/wav");
    expect(names).toEqual(["audio.ogg", "audio.mp4", "audio.wav"]);
  });

  it("501 without a key, 400 on empty audio, 413 over the cap — before any fetch", async () => {
    let called = 0;
    const counting = (async () => {
      called++;
      return { ok: true, json: async () => ({ text: "" }) } as Response;
    }) as unknown as typeof fetch;
    await expect(proxy(counting, null).transcribe(Buffer.from("x"), "audio/webm")).rejects.toMatchObject({ status: 501 });
    await expect(proxy(counting).transcribe(Buffer.alloc(0), "audio/webm")).rejects.toMatchObject({ status: 400 });
    const big = Buffer.alloc(MAX_STT_BYTES + 1);
    await expect(proxy(counting).transcribe(big, "audio/webm")).rejects.toMatchObject({ status: 413 });
    expect(called).toBe(0);
  });

  it("surfaces Groq's error message on a non-200, as an SttError", async () => {
    const failing = (async () => ({
      ok: false,
      status: 429,
      json: async () => ({ error: { message: "Rate limit reached." } }),
    })) as unknown as typeof fetch;
    await expect(proxy(failing).transcribe(Buffer.from("x"), "audio/webm")).rejects.toThrow(
      /HTTP 429: Rate limit reached/,
    );
  });

  it("wraps a network failure in a reachability SttError", async () => {
    const down = (async () => {
      throw new Error("fetch failed");
    }) as unknown as typeof fetch;
    const err = await proxy(down)
      .transcribe(Buffer.from("x"), "audio/webm")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SttError);
    expect((err as Error).message).toMatch(/could not reach/i);
  });
});
