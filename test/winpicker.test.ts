// The native Windows folder dialog (src/server/winpicker.ts). Pure/injected
// only — no test ever opens a real dialog.

import { describe, expect, it } from "vitest";
import {
  PICK_CANCELLED,
  PWSH_PATHS,
  PickError,
  findPowerShell,
  pickFolderScript,
  pickWindowsFolder,
} from "../src/server/winpicker.js";

describe("findPowerShell", () => {
  // This choice IS the dialog the user sees: powershell.exe is 5.1 on .NET
  // Framework, whose FolderBrowserDialog is the XP-era tree that opens on the
  // Desktop and refuses to navigate to \\wsl$; pwsh is modern .NET, where the
  // same class is the Windows 11 dialog and opens on the WSL path it is given.
  it("prefers PowerShell 7 when it is installed", () => {
    expect(findPowerShell((p) => p === PWSH_PATHS[0])).toBe(PWSH_PATHS[0]);
  });

  it("falls back to powershell.exe — the old dialog beats no dialog", () => {
    expect(findPowerShell(() => false)).toBe("powershell.exe");
  });
});

describe("pickFolderScript", () => {
  it("owns the dialog with a TopMost form", () => {
    const script = pickFolderScript("\\\\wsl$\\Ubuntu\\home");
    // Without an owner the dialog opens BEHIND the browser the user just
    // clicked in, which reads as "the button does nothing".
    expect(script).toContain("$owner.TopMost = $true");
    expect(script).toContain("$dialog.ShowDialog($owner)");
  });

  it("starts where it was told and reports a cancel distinctly from a path", () => {
    const script = pickFolderScript("\\\\wsl$\\Ubuntu\\home\\rod\\projects");
    expect(script).toContain("$dialog.SelectedPath = '\\\\wsl$\\Ubuntu\\home\\rod\\projects'");
    expect(script).toContain(PICK_CANCELLED);
  });

  it("a quote in the folder name cannot end the PowerShell literal", () => {
    // "C:\Users\Tim O'Brien\projects" is an ordinary Windows path.
    const script = pickFolderScript("C:\\Users\\Tim O'Brien\\projects");
    expect(script).toContain("'C:\\Users\\Tim O''Brien\\projects'");
  });
});

describe("pickWindowsFolder", () => {
  const distro = "Ubuntu";

  it("translates the chosen Windows path into a WSL one", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const picked = await pickWindowsFolder(undefined, {
      distro,
      shell: "pwsh.exe",
      exec: async (file, args) => {
        calls.push({ file, args });
        if (file === "pwsh.exe") {
          return { stdout: "\\\\wsl$\\Ubuntu\\home\\rod\\ai panorama\r\n" };
        }
        return { stdout: "/home/rod/ai panorama\n" };
      },
    });
    expect(picked).toBe("/home/rod/ai panorama");
    // -STA is not optional: Windows Forms throws without it on 5.1, and pwsh
    // takes it too, so one argv serves both.
    expect(calls[0].args).toContain("-STA");
    expect(calls[1]).toEqual({ file: "wslpath", args: ["-u", "\\\\wsl$\\Ubuntu\\home\\rod\\ai panorama"] });
  });

  it("a cancelled dialog is null, not an error", async () => {
    const picked = await pickWindowsFolder(undefined, {
      distro,
      exec: async () => ({ stdout: `${PICK_CANCELLED}\r\n` }),
    });
    expect(picked).toBeNull();
  });

  it("opens on the operator's own home inside the distro, not on C:", async () => {
    let script = "";
    await pickWindowsFolder(undefined, {
      distro,
      homeDir: "/home/rod",
      shell: "pwsh.exe",
      exec: async (file, args) => {
        if (file === "pwsh.exe") {
          script = args[args.length - 1];
          return { stdout: `${PICK_CANCELLED}\n` };
        }
        return { stdout: "" };
      },
    });
    // The projects live here. The Desktop, where the dialog lands on its own,
    // is the one place they are not.
    expect(script).toContain("$dialog.SelectedPath = '\\\\wsl$\\Ubuntu\\home\\rod'");
  });

  it("translates the WSL path the form holds into the Windows one SelectedPath needs", async () => {
    let script = "";
    await pickWindowsFolder("/home/rod/projects/ai panorama", {
      distro,
      shell: "pwsh.exe",
      exec: async (file, args) => {
        if (file === "pwsh.exe") {
          script = args[args.length - 1];
          return { stdout: `${PICK_CANCELLED}\n` };
        }
        return { stdout: "" };
      },
    });
    // Handing SelectedPath a POSIX path opens the dialog wherever it likes.
    expect(script).toContain("'\\\\wsl$\\Ubuntu\\home\\rod\\projects\\ai panorama'");
  });

  it("a Windows path from the form is passed through untouched", async () => {
    let script = "";
    await pickWindowsFolder("C:\\projects", {
      distro,
      shell: "pwsh.exe",
      exec: async (file, args) => {
        if (file === "pwsh.exe") {
          script = args[args.length - 1];
          return { stdout: `${PICK_CANCELLED}\n` };
        }
        return { stdout: "" };
      },
    });
    expect(script).toContain("'C:\\projects'");
  });

  it("outside WSL it asks for the fallback instead of failing", async () => {
    await expect(pickWindowsFolder(undefined, { distro: "" })).rejects.toMatchObject({
      unsupported: true,
    });
  });

  it("a missing powershell.exe asks for the fallback too", async () => {
    const err = Object.assign(new Error("spawn powershell.exe ENOENT"), { code: "ENOENT" });
    const promise = pickWindowsFolder(undefined, {
      distro,
      exec: async () => {
        throw err;
      },
    });
    await expect(promise).rejects.toBeInstanceOf(PickError);
    await expect(promise).rejects.toMatchObject({ unsupported: true });
  });
});
