import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { designFromPrompt } from "../src/design.js";
import { makeZip } from "../src/zip.js";
import { WAVE_TYPES } from "../src/engine.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "..", "src", "web.js");
const PORT = 4899;
const BASE = `http://127.0.0.1:${PORT}`;

let child;
let outputDir;

async function api(pathname, options = {}) {
  const res = await fetch(BASE + pathname, {
    headers: { "content-type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

before(async () => {
  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "bfxr-web-"));
  child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      BFXR_OUTPUT_DIR: outputDir,
      BFXR_PORT: String(PORT),
      BFXR_DESIGNER: "keywords", // never call the API from tests
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      await fetch(`${BASE}/api/state`);
      return;
    } catch {
      if (Date.now() > deadline) throw new Error("server did not start");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
});

after(() => {
  child?.kill();
  if (outputDir) fs.rmSync(outputDir, { recursive: true, force: true });
});

test("serves the page", async () => {
  const res = await fetch(BASE + "/");
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /bfxr sound library/);
  assert.match(html, /pollLibrary/);
});

test("state describes the library and the engine", async () => {
  const state = await api("/api/state");
  assert.equal(state.output_dir, path.resolve(outputDir));
  assert.equal(state.designer, "keywords");
  assert.ok(state.presets.includes("explosion"));
  assert.ok(state.parameters.length > 20);
  assert.deepEqual(state.sounds, []);
});

test("a prompt generates playable, downloadable sounds", async () => {
  const result = await api("/api/generate", {
    method: "POST",
    body: { prompt: "deep crunchy explosion", count: 3, group: "boom" },
  });

  assert.equal(result.sounds.length, 3);
  assert.equal(result.preset, "explosion");
  assert.equal(result.designer, "keywords");

  for (const sound of result.sounds) {
    assert.ok(sound.duration > 0, "sound has length");
    assert.equal(sound.group, "boom");
    assert.ok(sound.peaks.length > 0, "waveform peaks present");
    assert.ok(fs.existsSync(path.join(outputDir, sound.file)));

    const audio = await fetch(`${BASE}/api/audio/${sound.id}`);
    assert.equal(audio.status, 200);
    assert.equal(audio.headers.get("content-type"), "audio/wav");
    const bytes = Buffer.from(await audio.arrayBuffer());
    assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
  }

  const state = await api("/api/state");
  assert.equal(state.sounds.length, 3);
  assert.deepEqual(state.groups, ["boom"]);
});

test("rename, regroup, star, mutate and delete", async () => {
  const { sounds } = await api("/api/generate", {
    method: "POST",
    body: { preset: "jump", count: 1, name: "hop" },
  });
  const id = sounds[0].id;

  const renamed = await api(`/api/sounds/${id}`, {
    method: "PATCH",
    body: { name: "big hop", group: "player", starred: true },
  });
  assert.equal(renamed.name, "big hop");
  assert.equal(renamed.group, "player");
  assert.equal(renamed.starred, true);

  const mutated = await api("/api/mutate", {
    method: "POST",
    body: { id, count: 2 },
  });
  assert.equal(mutated.sounds.length, 2);
  assert.equal(mutated.sounds[0].group, "player", "variations inherit the group");

  const deleted = await api(`/api/sounds/${id}`, { method: "DELETE" });
  assert.equal(deleted.deleted, id);
  assert.ok(!fs.existsSync(path.join(outputDir, `${id}.wav`)));

  const state = await api("/api/state");
  assert.ok(!state.sounds.some((s) => s.id === id));
});

test("the editor previews parameters without touching the library", async () => {
  const state = await api("/api/state");
  const before = state.sounds.length;

  const result = await api("/api/preview", {
    method: "POST",
    body: {
      params: { ...state.defaults, waveType: WAVE_TYPES.Square, sustainTime: 0.5 },
      seed: 99,
      name: "scratch",
    },
  });

  assert.ok(result.duration > 0, "preview has length");
  assert.equal(result.wave_type, "Square");
  assert.ok(result.peaks.length > 200, "high-resolution peaks for the big canvas");
  assert.match(result.permalink, /^https:\/\/www\.bfxr\.net\/\?sfx=/);
  assert.equal(
    Buffer.from(result.wav, "base64").toString("ascii", 0, 4),
    "RIFF",
    "playable audio comes back inline",
  );

  const after = await api("/api/state");
  assert.equal(after.sounds.length, before, "nothing was written to disk");
});

test("the editor's sliders and buttons are described by /api/state", async () => {
  const state = await api("/api/state");
  const named = new Set(state.parameters.map((p) => p.name));

  for (const group of state.param_groups) {
    for (const name of group.params) {
      assert.ok(named.has(name), `${name} in ${group.title} is a real parameter`);
    }
  }
  const grouped = new Set(state.param_groups.flatMap((g) => g.params));
  for (const param of state.parameters) {
    if (param.type !== "number") continue;
    assert.ok(grouped.has(param.name), `${param.name} has a slider somewhere`);
  }

  const waveType = state.parameters.find((p) => p.name === "waveType");
  assert.equal(waveType.values.length, Object.keys(WAVE_TYPES).length);
  assert.ok(waveType.values.every((v) => v.description), "buttons have tooltips");
  assert.equal(Object.keys(state.defaults).length, state.parameters.length);
});

test("parameter sets for the preset / randomize / mutate buttons", async () => {
  const reset = await api("/api/params", { method: "POST", body: { action: "reset" } });
  const preset = await api("/api/params", {
    method: "POST",
    body: { action: "preset", preset: "laser_shoot", seed: 5 },
  });
  assert.notDeepEqual(preset.params, reset.params);

  const again = await api("/api/params", {
    method: "POST",
    body: { action: "preset", preset: "laser_shoot", seed: 5 },
  });
  assert.deepEqual(again.params, preset.params, "the same seed repeats");

  const mutated = await api("/api/params", {
    method: "POST",
    body: { action: "mutate", params: preset.params, amount: 0.2, seed: 11 },
  });
  assert.notDeepEqual(mutated.params, preset.params);

  await assert.rejects(
    () => api("/api/params", { method: "POST", body: { action: "wat" } }),
    /Unknown action/,
  );
});

test("editing a sound re-renders it in place", async () => {
  const { sounds } = await api("/api/save", {
    method: "POST",
    body: {
      params: { ...(await api("/api/state")).defaults, sustainTime: 0.1 },
      name: "editable",
      group: "edits",
      seed: 1234,
    },
  });
  const original = sounds[0];
  assert.equal(original.group, "edits");

  const fetched = await api(`/api/sounds/${original.id}`);
  assert.deepEqual(fetched.params, original.params);

  const edited = await api(`/api/sounds/${original.id}`, {
    method: "PATCH",
    body: {
      name: "much longer",
      params: { ...fetched.params, sustainTime: 0.9, decayTime: 0.9 },
    },
  });

  assert.equal(edited.id, original.id, "the id survives an edit");
  assert.equal(edited.file, original.file, "so does the file");
  assert.equal(edited.name, "much longer");
  assert.ok(edited.duration > original.duration, "the audio really changed");
  assert.notEqual(edited.permalink, original.permalink);
  assert.ok(edited.edited, "the edit is stamped");

  const wav = fs.readFileSync(path.join(outputDir, edited.file));
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  const samples = wav.readUInt32LE(40) / 2;
  assert.ok(
    Math.abs(samples / 44100 - edited.duration) < 0.01,
    "the file on disk is as long as the library says",
  );

  const state = await api("/api/state");
  const listed = state.sounds.find((s) => s.id === original.id);
  assert.equal(listed.duration, edited.duration, "the library agrees");
  assert.notDeepEqual(listed.peaks, original.peaks, "the waveform was redrawn");
});

test("permalinks and .bfxr files open in the editor", async () => {
  const source = await api("/api/params", {
    method: "POST",
    body: { action: "preset", preset: "powerup", seed: 8 },
  });
  const { permalink } = await api("/api/preview", {
    method: "POST",
    body: { params: source.params, name: "zap" },
  });

  const opened = await api("/api/import", { method: "POST", body: { text: permalink } });
  assert.equal(opened.name, "zap");
  for (const [key, value] of Object.entries(source.params)) {
    assert.ok(Math.abs(opened.params[key] - value) < 1e-6, `${key} round-trips`);
  }

  const fromFile = await api("/api/import", {
    method: "POST",
    body: {
      text: JSON.stringify({
        synth_type: "Bfxr",
        file_name: "from-file",
        params: source.params,
      }),
    },
  });
  assert.equal(fromFile.name, "from-file");

  await assert.rejects(
    () => api("/api/import", { method: "POST", body: { text: "not a sound" } }),
    /Only Bfxr sounds are supported/,
  );
  await assert.rejects(
    () => api("/api/import", { method: "POST", body: { text: "" } }),
    /Paste a bfxr\.net link/,
  );
});

test("selected sounds download as a zip", async () => {
  const state = await api("/api/state");
  const ids = state.sounds.slice(0, 2).map((s) => s.id);
  const res = await fetch(
    `${BASE}/api/zip?ids=${ids.join(",")}&name=pack`,
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/zip");
  assert.match(res.headers.get("content-disposition"), /pack\.zip/);

  const zip = Buffer.from(await res.arrayBuffer());
  assert.equal(zip.toString("ascii", 0, 2), "PK");
  // End-of-central-directory record reports the entry count.
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.equal(zip.readUInt16LE(eocd + 10), ids.length);
});

test("bad requests are reported, not crashes", async () => {
  await assert.rejects(
    () => api("/api/mutate", { method: "POST", body: { id: "nope" } }),
    /No such sound/,
  );
  await assert.rejects(
    () => api("/api/generate", { method: "POST", body: { preset: "nope" } }),
    /Unknown preset/,
  );
  const missing = await fetch(`${BASE}/api/audio/nope`);
  assert.equal(missing.status, 404);
});

test("the keyword designer maps descriptions to presets and params", () => {
  assert.equal(designFromPrompt("collect a gold coin").preset, "pickup_coin");
  assert.equal(designFromPrompt("pew pew laser").preset, "laser_shoot");
  assert.equal(designFromPrompt("menu click").preset, "blip_select");
  assert.equal(designFromPrompt("nondescript whatsit").preset, "tone");

  const deep = designFromPrompt("deep explosion");
  assert.ok(deep.params.frequency_start < 0.3, "deep lowers the pitch");

  const crunchy = designFromPrompt("crunchy lo-fi hit");
  assert.ok(crunchy.params.bitCrush > 0, "crunchy adds bit crush");

  const noisy = designFromPrompt("noisy whoosh");
  assert.equal(noisy.params.waveType, WAVE_TYPES.White);

  const square = designFromPrompt("square wave beep");
  assert.equal(square.params.waveType, WAVE_TYPES.Square);

  assert.equal(designFromPrompt("tiny ui blip").name, "tiny_ui_blip");
});

test("zip archives round-trip through the system unzip", async () => {
  const zip = makeZip([
    { name: "a.txt", data: Buffer.from("hello zip") },
    { name: "folder/b.txt", data: Buffer.from("nested") },
  ]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bfxr-zip-"));
  const file = path.join(dir, "test.zip");
  fs.writeFileSync(file, zip);

  const { execFileSync } = await import("node:child_process");
  const listing = execFileSync("unzip", ["-l", file], { encoding: "utf8" });
  assert.match(listing, /a\.txt/);
  assert.match(listing, /folder\/b\.txt/);

  execFileSync("unzip", ["-q", file, "-d", path.join(dir, "out")]);
  assert.equal(
    fs.readFileSync(path.join(dir, "out", "folder", "b.txt"), "utf8"),
    "nested",
  );
  fs.rmSync(dir, { recursive: true, force: true });
});
