// The "open in a system app" gate. The allowlist is the security-critical part:
// Windows RUNS what it opens, and the path can come from an agent's message, so
// a miss here turns "click a path" into "execute what an agent wrote".

import { describe, expect, it } from "vitest";
import { createWindowsFileOpener, isOpenable, OPENABLE_EXT, refusalFor } from "../src/server/fileopen.js";

describe("isOpenable", () => {
  it("allows the inert media the dashboard cannot render", () => {
    expect(isOpenable("/x/clip.mp4")).toBe(true);
    expect(isOpenable("/x/song.mp3")).toBe(true);
    expect(isOpenable("/x/doc.pdf")).toBe(true);
    expect(isOpenable("/x/sheet.xlsx")).toBe(true);
    expect(isOpenable("/x/bundle.zip")).toBe(true);
    expect(isOpenable("/x/shot.PNG")).toBe(true); // case-insensitive
  });

  it("REFUSES anything the Windows shell would execute", () => {
    for (const p of [
      "/x/evil.exe", "/x/evil.bat", "/x/evil.cmd", "/x/evil.ps1", "/x/evil.msi",
      "/x/evil.vbs", "/x/evil.js", "/x/evil.jse", "/x/evil.wsf", "/x/evil.scr",
      "/x/evil.com", "/x/evil.hta", "/x/evil.reg", "/x/evil.lnk", "/x/evil.jar",
      "/x/evil.sh",
    ]) {
      expect(isOpenable(p), `${p} must not be openable`).toBe(false);
    }
  });

  it("REFUSES macro-enabled Office — a script wearing a document's extension", () => {
    expect(isOpenable("/x/book.docm")).toBe(false);
    expect(isOpenable("/x/book.xlsm")).toBe(false);
    expect(isOpenable("/x/deck.pptm")).toBe(false);
    // …while their macro-free twins pass.
    expect(isOpenable("/x/book.docx")).toBe(true);
  });

  it("REFUSES what it does not recognise (allowlist, not denylist)", () => {
    expect(isOpenable("/x/thing.wat")).toBe(false);
    expect(isOpenable("/x/noext")).toBe(false);
    expect(isOpenable("/x/.bashrc")).toBe(false);
  });

  it("carries no executable extension in the allowlist at all", () => {
    for (const bad of [".exe", ".bat", ".cmd", ".ps1", ".sh", ".msi", ".vbs", ".jar", ".lnk"]) {
      expect(OPENABLE_EXT.has(bad), `${bad} leaked into the allowlist`).toBe(false);
    }
  });
});

describe("refusalFor", () => {
  it("says what was refused and why, for the operator", () => {
    const msg = refusalFor("/x/evil.bat");
    expect(msg).toContain(".bat");
    expect(msg).toMatch(/RUNS what it opens/i);
  });
});

describe("createWindowsFileOpener", () => {
  const calls: { file: string; args: string[] }[] = [];
  const exec = (stdout: string, fail?: (file: string) => Error | null) =>
    (async (file: string, args: string[]) => {
      calls.push({ file, args });
      const err = fail?.(file);
      if (err) throw err;
      return { stdout };
    }) as never;

  it("is null off WSL — there is no Windows side to open on", () => {
    // The distro falls back to $WSL_DISTRO_NAME, and the suite itself usually
    // runs under WSL — so a non-WSL host has to be simulated, not assumed.
    const saved = process.env.WSL_DISTRO_NAME;
    delete process.env.WSL_DISTRO_NAME;
    try {
      expect(createWindowsFileOpener({ exec: exec("") })).toBeNull();
    } finally {
      if (saved !== undefined) process.env.WSL_DISTRO_NAME = saved;
    }
  });

  it("translates the path with wslpath, then hands it to explorer", async () => {
    calls.length = 0;
    const opener = createWindowsFileOpener({ exec: exec("\\\\wsl$\\Ubuntu\\home\\r\\a.mp4\n"), distro: "Ubuntu" });
    await opener!.open("/home/r/a.mp4");
    expect(calls[0]).toEqual({ file: "wslpath", args: ["-w", "/home/r/a.mp4"] });
    expect(calls[1].file).toBe("explorer.exe");
    expect(calls[1].args).toEqual(["\\\\wsl$\\Ubuntu\\home\\r\\a.mp4"]); // trimmed
  });

  it("throws when wslpath yields nothing rather than opening a blank path", async () => {
    const opener = createWindowsFileOpener({ exec: exec("  \n"), distro: "Ubuntu" });
    await expect(opener!.open("/home/r/a.mp4")).rejects.toThrow(/no Windows path/i);
  });

  it("ignores explorer's exit code — it is non-zero even on success", async () => {
    const boom = Object.assign(new Error("Command failed"), { code: 1 });
    const opener = createWindowsFileOpener({
      exec: exec("C:\\a.mp4", (f) => (f === "explorer.exe" ? boom : null)),
      distro: "Ubuntu",
    });
    await expect(opener!.open("/home/r/a.mp4")).resolves.toBeUndefined();
  });

  it("falls back to the absolute explorer when PATH has no /mnt/c (real report)", async () => {
    calls.length = 0;
    const enoent = Object.assign(new Error("spawn explorer.exe ENOENT"), { code: "ENOENT" });
    const opener = createWindowsFileOpener({
      exec: exec("C:\\a.mp4", (f) => (f === "explorer.exe" ? enoent : null)),
      distro: "Ubuntu",
    });
    await opener!.open("/home/r/a.mp4");
    expect(calls.map((c) => c.file)).toEqual(["wslpath", "explorer.exe", "/mnt/c/Windows/explorer.exe"]);
  });
});

describe("createWindowsFileOpener.reveal", () => {
  const calls: { file: string; args: string[] }[] = [];
  const exec = (stdout: string, fail?: (file: string) => Error | null) =>
    (async (file: string, args: string[]) => {
      calls.push({ file, args });
      const err = fail?.(file);
      if (err) throw err;
      return { stdout };
    }) as never;

  it("hands explorer ONE `/select,<win>` token — Explorer's own comma syntax", async () => {
    calls.length = 0;
    const opener = createWindowsFileOpener({ exec: exec("\\\\wsl$\\Ubuntu\\home\\r\\shot.png\n"), distro: "Ubuntu" });
    await opener!.reveal("/home/r/shot.png");
    expect(calls[0]).toEqual({ file: "wslpath", args: ["-w", "/home/r/shot.png"] });
    expect(calls[1].file).toBe("explorer.exe");
    expect(calls[1].args).toEqual(["/select,\\\\wsl$\\Ubuntu\\home\\r\\shot.png"]);
  });

  it("falls back to the absolute explorer path when PATH lacks /mnt/c", async () => {
    calls.length = 0;
    const enoent = Object.assign(new Error("spawn explorer.exe ENOENT"), { code: "ENOENT" });
    const opener = createWindowsFileOpener({
      exec: exec("C:\\shot.png", (f) => (f === "explorer.exe" ? enoent : null)),
      distro: "Ubuntu",
    });
    await opener!.reveal("/home/r/shot.png");
    expect(calls[2].file).toBe("/mnt/c/Windows/explorer.exe");
    expect(calls[2].args).toEqual(["/select,C:\\shot.png"]);
  });
});
