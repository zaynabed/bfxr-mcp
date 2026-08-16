/**
 * The sound library: a `library.json` sidecar in the output directory that
 * indexes every .wav this server has written. Both the MCP tools and the web UI
 * read and write it, so a sound generated either way shows up in both.
 */

import fs from "node:fs";
import path from "node:path";

const LIBRARY_FILE = "library.json";
const PEAK_BUCKETS = 72;

function libraryPath(dir) {
  return path.join(dir, LIBRARY_FILE);
}

export function loadLibrary(dir) {
  const file = libraryPath(dir);
  if (!fs.existsSync(file)) return { version: 1, sounds: [] };
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(data.sounds)) return { version: 1, sounds: [] };
    // Drop entries whose .wav has been deleted from under us.
    data.sounds = data.sounds.filter((entry) =>
      fs.existsSync(path.join(dir, entry.file)),
    );
    return data;
  } catch {
    // A corrupt index shouldn't take the whole server down — start fresh.
    return { version: 1, sounds: [] };
  }
}

function saveLibrary(dir, library) {
  fs.writeFileSync(libraryPath(dir), JSON.stringify(library, null, 2));
}

export function addEntry(dir, entry) {
  const library = loadLibrary(dir);
  library.sounds = library.sounds.filter((s) => s.id !== entry.id);
  library.sounds.push(entry);
  saveLibrary(dir, library);
  return entry;
}

export function getEntry(dir, id) {
  return loadLibrary(dir).sounds.find((s) => s.id === id) || null;
}

export function updateEntry(dir, id, changes) {
  const library = loadLibrary(dir);
  const entry = library.sounds.find((s) => s.id === id);
  if (!entry) return null;
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) continue;
    entry[key] = value;
  }
  saveLibrary(dir, library);
  return entry;
}

export function removeEntry(dir, id) {
  const library = loadLibrary(dir);
  const entry = library.sounds.find((s) => s.id === id);
  if (!entry) return null;

  library.sounds = library.sounds.filter((s) => s.id !== id);
  saveLibrary(dir, library);

  for (const file of [entry.file, entry.bfxr_file].filter(Boolean)) {
    const target = path.join(dir, path.basename(file));
    if (fs.existsSync(target)) fs.rmSync(target);
  }
  return entry;
}

export function groups(dir) {
  const seen = new Set();
  for (const sound of loadLibrary(dir).sounds) {
    if (sound.group) seen.add(sound.group);
  }
  return [...seen].sort();
}

/**
 * Min/max pairs per bucket, so the browser can draw a waveform without
 * fetching and decoding the audio first.
 * @param {Float32Array} samples
 */
export function peaks(samples, buckets = PEAK_BUCKETS) {
  const result = [];
  const size = Math.max(1, Math.floor(samples.length / buckets));
  for (let i = 0; i < buckets; i++) {
    let min = 0;
    let max = 0;
    const start = i * size;
    const end = Math.min(samples.length, start + size);
    for (let j = start; j < end; j++) {
      if (samples[j] < min) min = samples[j];
      if (samples[j] > max) max = samples[j];
    }
    result.push(Math.round(min * 1000) / 1000, Math.round(max * 1000) / 1000);
  }
  return result;
}
