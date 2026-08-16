import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function expandHome(p) {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function resolveOutputDir(requested) {
  const dir =
    requested || process.env.BFXR_OUTPUT_DIR || "~/Downloads/bfxr-sounds";
  const resolved = path.resolve(expandHome(dir));
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

/** Filesystem-safe base name derived from a user-supplied sound name. */
export function safeName(name, fallback = "sound") {
  const cleaned = String(name || "")
    .trim()
    .replace(/[^\w.\- ]+/g, "")
    .replace(/\s+/g, "_")
    .replace(/^[.\-]+/, "")
    .slice(0, 64);
  return cleaned || fallback;
}

/** Never clobber an existing file: foo.wav -> foo-2.wav -> foo-3.wav ... */
export function uniquePath(dir, base, ext) {
  let candidate = path.join(dir, `${base}${ext}`);
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base}-${n}${ext}`);
    n++;
  }
  return candidate;
}

export async function playFile(filePath) {
  const players =
    process.platform === "darwin"
      ? [["afplay", [filePath]]]
      : process.platform === "win32"
        ? [
            [
              "powershell",
              [
                "-c",
                `(New-Object Media.SoundPlayer '${filePath}').PlaySync()`,
              ],
            ],
          ]
        : [
            ["paplay", [filePath]],
            ["aplay", [filePath]],
            ["ffplay", ["-nodisp", "-autoexit", "-loglevel", "quiet", filePath]],
          ];

  let lastError;
  for (const [cmd, args] of players) {
    try {
      await execFileAsync(cmd, args, { timeout: 30_000 });
      return { played: true, player: cmd };
    } catch (error) {
      lastError = error;
    }
  }
  return {
    played: false,
    error: lastError ? lastError.message : "no audio player found",
  };
}
