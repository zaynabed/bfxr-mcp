#!/usr/bin/env node
/**
 * Local web UI for the sound library: prompt for a sound, hear the variations,
 * tag them into groups, download the ones you like.
 *
 * Serves on loopback only — it reads and writes files on this machine.
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  allPresets,
  completeParams,
  defaultParams,
  makeParams,
  mutateParams,
  parameterInfo,
  parseBfxrFile,
  parsePermalink,
  permalink,
  render,
  version,
  WAVE_NAMES,
  WAVE_TYPES,
} from "./engine.js";
import { createSound, updateSoundParams } from "./sounds.js";
import {
  getEntry,
  groups,
  loadLibrary,
  peaks,
  removeEntry,
  updateEntry,
} from "./library.js";
import { encodeWav } from "./wav.js";
import { designFromPrompt, nameFromPrompt } from "./design.js";
import { claudeAvailable, designWithClaude } from "./claude.js";
import { resolveOutputDir, safeName } from "./output.js";
import { makeZip } from "./zip.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = path.join(HERE, "ui", "index.html");
const MAX_BODY_BYTES = 1_000_000;

const OUTPUT_DIR = resolveOutputDir(process.env.BFXR_OUTPUT_DIR);

function randomSeed() {
  return Math.floor(Math.random() * 2 ** 31);
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

/* -------------------------------------------------------------- generation */

async function design(prompt) {
  if (claudeAvailable()) {
    try {
      const result = await designWithClaude(prompt);
      return { ...result, designer: "claude" };
    } catch (error) {
      console.error("[bfxr] Claude designer failed:", error.message);
      return {
        ...designFromPrompt(prompt),
        designer: "keywords",
        note: `Claude unavailable (${error.message}) — used the keyword designer.`,
      };
    }
  }
  return { ...designFromPrompt(prompt), designer: "keywords" };
}

async function generate(body) {
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  const count = Math.min(8, Math.max(1, Number(body.count) || 4));
  const group = typeof body.group === "string" ? body.group.trim() : "";

  let plan = { preset: body.preset || "tone", params: {}, designer: null };
  if (prompt && !body.preset) plan = await design(prompt);

  const overrides = { ...plan.params, ...(body.params || {}) };
  if (body.wave_type && WAVE_TYPES[body.wave_type] !== undefined) {
    overrides.waveType = WAVE_TYPES[body.wave_type];
  }

  const base = safeName(
    body.name || plan.name || (prompt ? nameFromPrompt(prompt) : plan.preset),
    "sound",
  );

  const sounds = [];
  for (let i = 0; i < count; i++) {
    const seed = randomSeed();
    const params = makeParams({ preset: plan.preset, params: overrides, seed });
    sounds.push(
      createSound({
        params,
        name: base,
        dir: OUTPUT_DIR,
        seed,
        group,
        prompt,
        preset: plan.preset,
        source: "web",
      }),
    );
  }

  return {
    sounds,
    preset: plan.preset,
    designer: plan.designer,
    rationale: plan.rationale || "",
    note: plan.note,
  };
}

function mutate(body) {
  const source = getEntry(OUTPUT_DIR, body.id);
  if (!source) throw new Error(`No such sound: ${body.id}`);

  const count = Math.min(8, Math.max(1, Number(body.count) || 3));
  const amount = Math.min(1, Math.max(0.01, Number(body.amount) || 0.1));
  const params = completeParams(source.params);
  const base = safeName(source.name.replace(/-\d+$/, ""), "mutation");

  const sounds = [];
  for (let i = 0; i < count; i++) {
    const seed = randomSeed();
    sounds.push(
      createSound({
        params: mutateParams(params, amount, seed),
        name: `${base}_alt`,
        dir: OUTPUT_DIR,
        seed,
        group: source.group,
        prompt: source.prompt,
        preset: source.preset,
        source: "web",
      }),
    );
  }
  return { sounds };
}

/* ------------------------------------------------------------------ editor */

/**
 * How the editor stacks its sliders, mirroring the panels on bfxr.net. Any
 * parameter the vendored synth grows that isn't listed here still shows up,
 * under "Other".
 */
const PARAM_GROUPS = [
  {
    title: "Envelope",
    params: [
      "attackTime",
      "sustainTime",
      "sustainPunch",
      "decayTime",
      "compressionAmount",
      "masterVolume",
    ],
  },
  {
    title: "Frequency",
    params: [
      "frequency_start",
      "frequency_slide",
      "frequency_acceleration",
      "min_frequency_relative_to_starting_frequency",
    ],
  },
  { title: "Vibrato", params: ["vibratoDepth", "vibratoSpeed"] },
  {
    title: "Pitch Jump",
    params: [
      "pitch_jump_repeat_speed",
      "pitch_jump_amount",
      "pitch_jump_onset_percent",
      "pitch_jump_2_amount",
      "pitch_jump_onset2_percent",
    ],
  },
  { title: "Harmonics", params: ["overtones", "overtoneFalloff"] },
  {
    title: "Square Wave",
    params: ["squareDuty", "dutySweep"],
    // Bfxr greys these out unless the square wave is selected.
    requires_wave: WAVE_TYPES.Square,
  },
  { title: "Repeat", params: ["repeatSpeed"] },
  { title: "Flanger", params: ["flangerOffset", "flangerSweep"] },
  {
    title: "Filters",
    params: [
      "lpFilterCutoff",
      "lpFilterCutoffSweep",
      "lpFilterResonance",
      "hpFilterCutoff",
      "hpFilterCutoffSweep",
    ],
  },
  { title: "Bit Crush", params: ["bitCrush", "bitCrushSweep"] },
];

/** Slider layout with anything the groups above missed appended. */
function paramGroups() {
  const known = new Set(PARAM_GROUPS.flatMap((group) => group.params));
  const rest = parameterInfo()
    .filter((p) => p.type === "number" && !known.has(p.name))
    .map((p) => p.name);
  return rest.length
    ? [...PARAM_GROUPS, { title: "Other", params: rest }]
    : PARAM_GROUPS;
}

const PREVIEW_BUCKETS = 240;

/**
 * Render parameters to audio without writing anything to disk — this is what
 * makes the sliders audible while you drag them.
 */
function preview(body) {
  const params = completeParams(body.params || {});
  const seed = Number.isFinite(Number(body.seed)) ? Number(body.seed) : undefined;
  const { samples, duration } = render(params, seed);

  if (samples.length === 0) {
    return { silent: true, duration: 0, peaks: [], params };
  }

  return {
    params,
    duration: Math.round(duration * 1000) / 1000,
    wave_type: WAVE_NAMES[params.waveType] || String(params.waveType),
    peaks: peaks(samples, PREVIEW_BUCKETS),
    permalink: permalink(params, body.name || "sound"),
    wav: Buffer.from(encodeWav(samples)).toString("base64"),
  };
}

/**
 * Parameter sets for the editor's buttons — preset, randomize, mutate, reset —
 * handed back without touching the library.
 */
function editorParams(body) {
  const seed = Number.isFinite(Number(body.seed)) ? Number(body.seed) : randomSeed();
  const action = body.action || "preset";

  if (action === "reset") return { params: defaultParams(), seed };
  if (action === "randomize") {
    return { params: makeParams({ preset: "random", seed }), seed };
  }
  if (action === "mutate") {
    const amount = Math.min(1, Math.max(0.01, Number(body.amount) || 0.1));
    return {
      params: mutateParams(completeParams(body.params || {}), amount, seed),
      seed,
    };
  }
  if (action === "preset") {
    return { params: makeParams({ preset: body.preset || "tone", seed }), seed };
  }
  throw new Error(`Unknown action "${action}".`);
}

/** Save the editor's current parameters as a brand new library entry. */
function save(body) {
  const seed = Number.isFinite(Number(body.seed)) ? Number(body.seed) : randomSeed();
  const entry = createSound({
    params: completeParams(body.params || {}),
    name: safeName(body.name, "sound"),
    dir: OUTPUT_DIR,
    seed,
    group: typeof body.group === "string" ? body.group.trim() : "",
    prompt: typeof body.prompt === "string" ? body.prompt : "",
    preset: typeof body.preset === "string" ? body.preset : "",
    source: "web",
  });
  return { sounds: [entry] };
}

/** Open a bfxr.net permalink or the contents of a .bfxr file in the editor. */
function importSound(body) {
  const text = String(body.text || "").trim();
  if (!text) throw new Error("Paste a bfxr.net link or the contents of a .bfxr file.");
  const parsed = text.startsWith("{")
    ? parseBfxrFile(text)
    : parsePermalink(text);
  return { name: parsed.name, params: completeParams(parsed.params) };
}

/* ------------------------------------------------------------------ routes */

function state() {
  return {
    output_dir: OUTPUT_DIR,
    engine_version: version(),
    designer: claudeAvailable() ? "claude" : "keywords",
    presets: allPresets(),
    wave_types: Object.keys(WAVE_TYPES),
    parameters: parameterInfo(),
    param_groups: paramGroups(),
    defaults: defaultParams(),
    groups: groups(OUTPUT_DIR),
    sounds: loadLibrary(OUTPUT_DIR).sounds.sort((a, b) =>
      b.created.localeCompare(a.created),
    ),
  };
}

function sendFile(res, entry, { download }) {
  const file = path.join(OUTPUT_DIR, entry.file);
  if (!fs.existsSync(file)) {
    json(res, 404, { error: "File is missing from disk" });
    return;
  }
  const headers = {
    "content-type": "audio/wav",
    "content-length": fs.statSync(file).size,
    "cache-control": "no-store",
  };
  if (download) {
    const name = `${safeName(entry.name, entry.id)}.wav`;
    headers["content-disposition"] = `attachment; filename="${name}"`;
  }
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}

function sendZip(res, ids, packName) {
  const library = loadLibrary(OUTPUT_DIR);
  const wanted = new Set(ids);
  const entries = library.sounds.filter((s) => wanted.has(s.id));
  if (entries.length === 0) {
    json(res, 404, { error: "No matching sounds" });
    return;
  }

  const used = new Map();
  const files = entries.map((entry) => {
    // Group name becomes a folder; duplicate display names get a suffix.
    const folder = entry.group ? `${safeName(entry.group)}/` : "";
    let name = `${folder}${safeName(entry.name, entry.id)}`;
    const seen = used.get(name) || 0;
    used.set(name, seen + 1);
    if (seen > 0) name = `${name}-${seen + 1}`;
    return {
      name: `${name}.wav`,
      data: fs.readFileSync(path.join(OUTPUT_DIR, entry.file)),
      date: new Date(entry.created),
    };
  });

  const zip = makeZip(files);
  res.writeHead(200, {
    "content-type": "application/zip",
    "content-length": zip.length,
    "content-disposition": `attachment; filename="${safeName(packName || "bfxr-sounds")}.zip"`,
  });
  res.end(zip);
}

async function route(req, res, url) {
  const { pathname, searchParams } = url;

  if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
    const html = fs.readFileSync(INDEX_HTML);
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": html.length,
    });
    res.end(html);
    return;
  }

  if (req.method === "GET" && pathname === "/api/state") {
    json(res, 200, state());
    return;
  }

  if (req.method === "POST" && pathname === "/api/generate") {
    json(res, 200, await generate(await readBody(req)));
    return;
  }

  if (req.method === "POST" && pathname === "/api/mutate") {
    json(res, 200, mutate(await readBody(req)));
    return;
  }

  if (req.method === "POST" && pathname === "/api/preview") {
    json(res, 200, preview(await readBody(req)));
    return;
  }

  if (req.method === "POST" && pathname === "/api/params") {
    json(res, 200, editorParams(await readBody(req)));
    return;
  }

  if (req.method === "POST" && pathname === "/api/save") {
    json(res, 200, save(await readBody(req)));
    return;
  }

  if (req.method === "POST" && pathname === "/api/import") {
    json(res, 200, importSound(await readBody(req)));
    return;
  }

  if (req.method === "GET" && pathname === "/api/zip") {
    const ids = (searchParams.get("ids") || "").split(",").filter(Boolean);
    sendZip(res, ids, searchParams.get("name"));
    return;
  }

  const audio = pathname.match(/^\/api\/audio\/(.+)$/);
  if (req.method === "GET" && audio) {
    const entry = getEntry(OUTPUT_DIR, decodeURIComponent(audio[1]));
    if (!entry) return json(res, 404, { error: "Unknown sound" });
    sendFile(res, entry, { download: searchParams.has("download") });
    return;
  }

  const sound = pathname.match(/^\/api\/sounds\/(.+)$/);
  if (sound) {
    const id = decodeURIComponent(sound[1]);
    if (req.method === "GET") {
      const entry = getEntry(OUTPUT_DIR, id);
      if (!entry) return json(res, 404, { error: "Unknown sound" });
      return json(res, 200, { ...entry, params: completeParams(entry.params) });
    }
    if (req.method === "PATCH") {
      const body = await readBody(req);
      const changes = {};
      if (typeof body.name === "string") changes.name = body.name.slice(0, 80);
      if (typeof body.group === "string") changes.group = body.group.slice(0, 60);
      if (typeof body.starred === "boolean") changes.starred = body.starred;
      let entry = updateEntry(OUTPUT_DIR, id, changes);
      if (!entry) return json(res, 404, { error: "Unknown sound" });
      // Editing parameters rewrites the .wav under the same name.
      if (body.params) {
        entry = updateSoundParams({
          entry,
          params: completeParams(body.params),
          dir: OUTPUT_DIR,
          seed: Number.isFinite(Number(body.seed))
            ? Number(body.seed)
            : (entry.seed ?? undefined),
        });
      }
      return json(res, 200, entry);
    }
    if (req.method === "DELETE") {
      const entry = removeEntry(OUTPUT_DIR, id);
      if (!entry) return json(res, 404, { error: "Unknown sound" });
      return json(res, 200, { deleted: entry.id });
    }
  }

  json(res, 404, { error: `No route for ${req.method} ${pathname}` });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  route(req, res, url).catch((error) => {
    console.error("[bfxr]", error);
    if (!res.headersSent) json(res, 400, { error: error.message });
    else res.end();
  });
});

const preferredPort = Number(process.env.BFXR_PORT) || 4747;

function listen(port, attempt = 0) {
  server.once("error", (error) => {
    if (error.code === "EADDRINUSE" && attempt < 10) {
      listen(port + 1, attempt + 1);
      return;
    }
    console.error(`[bfxr] Could not start server: ${error.message}`);
    process.exit(1);
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`bfxr sound library → http://localhost:${port}`);
    console.log(`sounds: ${OUTPUT_DIR}`);
    console.log(
      `prompt designer: ${claudeAvailable() ? "Claude API" : "built-in keyword mapper"}`,
    );
  });
}

listen(preferredPort);
