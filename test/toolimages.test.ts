// What the agent SAW, in the chat.
//
// A tool that hands back a screenshot writes it into the transcript as ~200 KB
// of base64, and resultToText only ever looked for text blocks — so the chip
// said "Read" and showed nothing at all. The fix cannot be "inline them": one
// conversation here holds 315 of those, which is ~60 MB of data URL in a chat
// payload. So the stream carries REFERENCES and the browser fetches each one.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { imagesInResult, parseConversation, sentFilesFrom, type ToolItem } from "../src/server/conversation.js";
import { startHub, type Hub } from "../src/server/hub.js";

// A 1x1 PNG, so the bytes are real without being large.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-shots-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("finding the images in a tool result", () => {
  const block = (data = PNG_B64, mediaType = "image/png") => ({
    type: "image",
    source: { type: "base64", media_type: mediaType, data },
  });

  it("describes each image without carrying it", () => {
    const found = imagesInResult([block(), { type: "text", text: "done" }, block()], "u-1");
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({ uuid: "u-1", index: 0, mediaType: "image/png" });
    expect(found[1].index).toBe(1);
    // The whole point: the reference must not contain the payload.
    expect(JSON.stringify(found)).not.toContain(PNG_B64);
  });

  it("reports the DECODED size, not the base64 length", () => {
    const [img] = imagesInResult([block()], "u-1");
    const actual = Buffer.from(PNG_B64, "base64").length;
    // Within a byte or two of the real thing — it drives a lazy-load decision,
    // and base64 overstates by a third.
    expect(Math.abs(img.bytes - actual)).toBeLessThanOrEqual(2);
  });

  it("ignores anything that is not a renderable image", () => {
    expect(imagesInResult([{ type: "text", text: "hi" }], "u")).toEqual([]);
    expect(imagesInResult("a plain string result", "u")).toEqual([]);
    expect(imagesInResult([block(PNG_B64, "application/pdf")], "u")).toEqual([]);
    // A URL source is not ours to serve out of the transcript.
    expect(imagesInResult([{ type: "image", source: { type: "url", url: "http://x/y.png" } }], "u")).toEqual([]);
  });

  it("returns nothing without a uuid to find it by", () => {
    // No uuid means no way to fetch it later; a reference that cannot be
    // resolved would render as a broken image.
    expect(imagesInResult([block()], "")).toEqual([]);
  });

  it("attaches them to the tool item when parsing a conversation", () => {
    const lines = [
      JSON.stringify({
        type: "assistant",
        uuid: "a-1",
        message: { role: "assistant", content: [{ type: "tool_use", id: "t-1", name: "Read", input: { file_path: "/tmp/x.png" } }] },
      }),
      JSON.stringify({
        type: "user",
        uuid: "u-9",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t-1", content: [block()] }] },
      }),
    ];
    const items = parseConversation(lines);
    const tool = items.find((i) => i.kind === "tool") as ToolItem | undefined;
    expect(tool).toBeTruthy();
    expect(tool!.images).toHaveLength(1);
    // The uuid recorded is the RESULT line's — that is where the bytes live.
    expect(tool!.images![0].uuid).toBe("u-9");
  });
});

describe("serving one image out of the transcript", () => {
  let hub: Hub;
  let project: string;
  let projectsDir: string;

  /** Writes a transcript Claude Code would have written for `project`. */
  function writeTranscript(records: unknown[]): void {
    // projectDirForCwd's encoding: the path with separators turned into dashes.
    const encoded = project.replace(/[/\\]/g, "-");
    const dirPath = path.join(projectsDir, encoded);
    fs.mkdirSync(dirPath, { recursive: true });
    fs.writeFileSync(
      path.join(dirPath, "session.jsonl"),
      records.map((r) => JSON.stringify(r)).join("\n") + "\n",
    );
  }

  beforeEach(async () => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-proj-"));
    projectsDir = path.join(os.homedir(), ".claude", "projects");
    hub = await startHub({ baseDir: dir, port: 0, quiet: true, onMessage: () => "queued_offline" });
    await fetch(`http://127.0.0.1:${hub.port}/api/agents/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "shooter", cwd: project, tmuxSession: "sb-shooter" }),
    });
  });

  afterEach(async () => {
    await hub?.close();
    const encoded = project.replace(/[/\\]/g, "-");
    fs.rmSync(path.join(projectsDir, encoded), { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  });

  function url(q: string): string {
    return `http://127.0.0.1:${hub.port}/api/agents/shooter/transcript/image?${q}`;
  }

  it("returns the decoded bytes with the right type", async () => {
    writeTranscript([
      {
        type: "user",
        uuid: "11111111-2222-3333-4444-555555555555",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t-1",
              content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG_B64 } }],
            },
          ],
        },
      },
    ]);
    const res = await fetch(url("uuid=11111111-2222-3333-4444-555555555555&i=0"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(Buffer.from(PNG_B64, "base64"))).toBe(true);
    // These bytes are DATA, never a document with privileges.
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("refuses a uuid that is not one, rather than going looking", async () => {
    writeTranscript([{ type: "user", uuid: "x", message: { role: "user", content: [] } }]);
    for (const bad of ["../../etc/passwd", "a".repeat(200), "; rm -rf /", ""]) {
      const res = await fetch(url(`uuid=${encodeURIComponent(bad)}`));
      expect(res.status, `uuid ${JSON.stringify(bad)}`).toBe(400);
    }
  });

  it("404s for a uuid that is well-formed but not there", async () => {
    writeTranscript([{ type: "user", uuid: "11111111-2222-3333-4444-555555555555", message: { role: "user", content: [] } }]);
    const res = await fetch(url("uuid=99999999-8888-7777-6666-555555555555&i=0"));
    expect(res.status).toBe(404);
  });

  it("404s for an index past the end", async () => {
    writeTranscript([
      {
        type: "user",
        uuid: "11111111-2222-3333-4444-555555555555",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t-1",
              content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG_B64 } }],
            },
          ],
        },
      },
    ]);
    const res = await fetch(url("uuid=11111111-2222-3333-4444-555555555555&i=7"));
    expect(res.status).toBe(404);
  });
});

describe("downloading a file the agent produced", () => {
  let hub: Hub;

  afterEach(async () => {
    await hub?.close();
  });

  it("only sets attachment when asked, and sanitises the name into the header", async () => {
    // The filename is interpolated into a HEADER. A newline in it would let a
    // file name inject one.
    const nasty = 're"port\nX-Evil: 1.md';
    const safeDir = path.join(os.homedir(), "Downloads");
    fs.mkdirSync(safeDir, { recursive: true });
    const file = path.join(safeDir, "switchboard-test-report.md");
    fs.writeFileSync(file, "# hello\n");
    try {
      hub = await startHub({ baseDir: dir, port: 0, quiet: true, onMessage: () => "queued_offline" });
      const base = `http://127.0.0.1:${hub.port}/api/files/raw?path=${encodeURIComponent(file)}`;

      const inline = await fetch(base);
      expect(inline.status).toBe(200);
      // Without the flag nothing changes: an .html an agent built still opens
      // as the site rather than landing in Downloads.
      expect(inline.headers.get("content-disposition")).toBeNull();

      const dl = await fetch(`${base}&download=1`);
      expect(dl.status).toBe(200);
      const cd = dl.headers.get("content-disposition") ?? "";
      expect(cd).toContain("attachment");
      expect(cd).toContain("switchboard-test-report.md");
      expect(cd).not.toContain("\n");
      expect(await dl.text()).toBe("# hello\n");
      void nasty;
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
});

describe("a file the agent hands over (SendUserFile)", () => {
  it("pulls out the files and the agent's caption", () => {
    const sent = sentFilesFrom("SendUserFile", {
      files: ["/home/x/PRECIFICACAO.md"],
      caption: "Precificação interna. Seção 4 tem os preços.",
      display: "attach",
    });
    expect(sent).toBeTruthy();
    expect(sent!.files).toEqual([{ path: "/home/x/PRECIFICACAO.md", name: "PRECIFICACAO.md" }]);
    expect(sent!.caption).toContain("Seção 4");
  });

  it("takes only absolute paths", () => {
    // A relative path would be resolved against something the agent never
    // meant, and the link would point at a file nobody asked for.
    expect(sentFilesFrom("SendUserFile", { files: ["notes.md", "../etc/passwd"] })).toBeNull();
    expect(sentFilesFrom("SendUserFile", { files: ["/a/ok.md", "relative.md"] })!.files).toHaveLength(1);
  });

  it("ignores every other tool", () => {
    expect(sentFilesFrom("Read", { files: ["/a/b.md"] })).toBeNull();
    expect(sentFilesFrom("SendUserFile", {})).toBeNull();
    expect(sentFilesFrom("SendUserFile", null)).toBeNull();
  });

  it("reaches the chat item, caption and all", () => {
    const lines = [
      JSON.stringify({
        type: "assistant",
        uuid: "a-2",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "t-9",
              name: "SendUserFile",
              input: { files: ["/tmp/report.pdf"], caption: "Contrato v3, 5 páginas." },
            },
          ],
        },
      }),
    ];
    const tool = parseConversation(lines).find((i) => i.kind === "tool") as ToolItem;
    expect(tool.files).toHaveLength(1);
    expect(tool.files![0].name).toBe("report.pdf");
    expect(tool.caption).toBe("Contrato v3, 5 páginas.");
  });
});
