/** Render + write a sound, and index it in the library. Shared by the MCP server and the web UI. */

import fs from "node:fs";
import path from "node:path";

import { permalink, render, toBfxrFile, WAVE_NAMES } from "./engine.js";
import { encodeWav } from "./wav.js";
import { addEntry, peaks } from "./library.js";
import { safeName, uniquePath } from "./output.js";

/**
 * @param {object} options
 * @param {object} options.params full Bfxr parameter set
 * @param {string} options.name base filename
 * @param {string} options.dir output directory
 * @param {number} [options.seed] makes noise waveforms reproducible
 * @param {boolean} [options.saveBfxr] also write a .bfxr project file
 * @param {string} [options.group] library grouping
 * @param {string} [options.prompt] what was asked for, if anything
 * @param {string} [options.preset] preset it started from
 * @param {string} [options.source] "mcp" | "web"
 * @returns {object} the library entry
 */
export function createSound({
  params,
  name,
  dir,
  seed,
  saveBfxr = false,
  group = "",
  prompt = "",
  preset = "",
  source = "mcp",
}) {
  const { samples, duration } = render(params, seed);
  if (samples.length === 0) {
    throw new Error(
      "Synthesis produced a silent buffer — try a different preset or a higher frequency_start / sustainTime.",
    );
  }

  const wavPath = uniquePath(dir, safeName(name), ".wav");
  fs.writeFileSync(wavPath, encodeWav(samples));

  const file = path.basename(wavPath);
  const id = path.basename(wavPath, ".wav");

  const entry = {
    id,
    file,
    name: id,
    group,
    prompt,
    preset,
    source,
    seed: seed ?? null,
    wave_type: WAVE_NAMES[params.waveType] || String(params.waveType),
    duration: Math.round(duration * 1000) / 1000,
    created: new Date().toISOString(),
    starred: false,
    permalink: permalink(params, id),
    params,
    peaks: peaks(samples),
  };

  if (saveBfxr) {
    const bfxrPath = path.join(dir, `${id}.bfxr`);
    fs.writeFileSync(bfxrPath, toBfxrFile(params, id));
    entry.bfxr_file = path.basename(bfxrPath);
  }

  addEntry(dir, entry);
  return entry;
}

/** The shape the MCP tools report back — the library entry minus the bulky bits. */
export function summarize(entry, dir) {
  return {
    file: path.join(dir, entry.file),
    duration_seconds: entry.duration,
    permalink: entry.permalink,
  };
}
