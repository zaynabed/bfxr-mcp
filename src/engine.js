/**
 * Runs the real Bfxr synth (vendored from https://github.com/increpare/bfxr2, MIT)
 * inside a Node vm sandbox, so sound generation is bit-for-bit the same synthesis
 * the web app does — just without a browser.
 */

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VENDOR = path.join(HERE, "..", "vendor", "bfxr2");

// Load order mirrors index.html in the upstream repo.
const VENDOR_FILES = [
  "globals.js",
  "templates.js",
  "AKWF.js",
  "Bfxr_DSP.js",
  "SynthBase.js",
  "Bfxr.js",
];

export const WAVE_TYPES = {
  Square: 0,
  Saw: 1,
  Sin: 2,
  White: 3,
  Triangle: 4,
  Rasp: 5,
  Tan: 6,
  Whistle: 7,
  Breaker: 8,
  Bitnoise: 9,
  FMSyn: 10,
  Voice: 11,
};

export const WAVE_NAMES = Object.fromEntries(
  Object.entries(WAVE_TYPES).map(([name, index]) => [index, name]),
);

/** Hand-written generators on the Bfxr class, exposed as friendly preset names. */
const PRESETS = {
  pickup_coin: "generate_pickup_coin",
  laser_shoot: "generate_laser_shoot",
  explosion: "generate_explosion",
  powerup: "generate_powerup",
  hit_hurt: "generate_hit_hurt",
  jump: "generate_jump",
  blip_select: "generate_blip_select",
  random: "randomize_params",
  tone: "generate_sin",
};

export const PRESET_NAMES = Object.keys(PRESETS);

/** mulberry32 — small seeded PRNG so `seed` gives reproducible sounds. */
function seededRandom(seed) {
  let a = seed >>> 0;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let sandbox = null;
let rng = Math.random;

function loadSandbox() {
  if (sandbox) return sandbox;

  const context = vm.createContext({
    // The vendored code logs; stdout belongs to the MCP protocol, so send it to stderr.
    console: {
      log: (...args) => console.error("[bfxr]", ...args),
      error: (...args) => console.error("[bfxr]", ...args),
      warn: (...args) => console.error("[bfxr]", ...args),
    },
  });

  const prelude = `
    const SAMPLE_RATE = 44100;
    const CONVERSION_FACTOR = (2 * Math.PI) / SAMPLE_RATE;
    // Bfxr.generate_sound() wraps its buffer in a Web Audio object; we read the
    // DSP buffer directly, so a passthrough is all that's needed here.
    class RealizedSound {
      constructor(buffer) { this.buffer = buffer; }
      static from_buffer(buffer) { return new RealizedSound(buffer); }
      getBuffer() { return this.buffer; }
      stop() {}
    }
  `;

  const sources = [prelude];
  for (const file of VENDOR_FILES) {
    sources.push(fs.readFileSync(path.join(VENDOR, file), "utf8"));
  }
  // Everything is concatenated into one script so the class declarations share
  // a single lexical scope, exactly like <script> tags on one page.
  sources.push("({ Bfxr, Bfxr_DSP, TEMPLATES_JSON })");

  const exported = vm.runInContext(sources.join("\n;\n"), context, {
    filename: "bfxr2-bundle.js",
  });

  // Route the vendored code's randomness through our (optionally seeded) RNG.
  vm.runInContext("Math", context).random = () => rng();

  sandbox = {
    context,
    Bfxr: exported.Bfxr,
    Bfxr_DSP: exported.Bfxr_DSP,
    TEMPLATES_JSON: exported.TEMPLATES_JSON,
  };
  return sandbox;
}

function withRandom(seed, fn) {
  const previous = rng;
  rng = seed === undefined || seed === null ? Math.random : seededRandom(seed);
  try {
    return fn();
  } finally {
    rng = previous;
  }
}

let cachedSynth = null;
function synth() {
  if (!cachedSynth) cachedSynth = new (loadSandbox().Bfxr)();
  return cachedSynth;
}

/** Preset names that came from the bundled .bcol template collection. */
export function templatePresets() {
  const templates = loadSandbox().TEMPLATES_JSON.Bfxr || {};
  return Object.keys(templates);
}

export function allPresets() {
  return [...new Set([...PRESET_NAMES, ...templatePresets()])];
}

export function version() {
  return loadSandbox().Bfxr_DSP.version;
}

/** Normalized metadata for every Bfxr parameter. */
export function parameterInfo() {
  const s = synth();
  return s.param_info.map((param) => {
    const normalized = s.get_param_normalized(param);
    if (Array.isArray(param)) {
      return {
        name: normalized.name,
        type: "number",
        default: normalized.default_value,
        min: normalized.min_value,
        max: normalized.max_value,
        label: param[0],
        description: param[1],
      };
    }
    return {
      name: normalized.name,
      type: "enum",
      default: normalized.default_value,
      min: normalized.min_value,
      max: normalized.max_value - 1,
      label: param.display_name || param.name,
      description: "Waveform. Use the wave_type argument to set this by name.",
      values: Object.entries(WAVE_TYPES).map(([waveName, index]) => ({
        name: waveName,
        index,
        description: (param.values.find((v) => v[0] === waveName) || [])[1],
      })),
    };
  });
}

export function parameterNames() {
  return parameterInfo().map((p) => p.name);
}

export function defaultParams() {
  return synth().default_params();
}

/**
 * Build a parameter set.
 * @param {object} options
 * @param {string} [options.preset] preset name (see allPresets())
 * @param {object} [options.params] parameter overrides applied after the preset
 * @param {number} [options.seed] makes preset randomization reproducible
 */
export function makeParams({ preset, params, seed } = {}) {
  const s = synth();

  return withRandom(seed, () => {
    s.reset_params();

    if (preset) {
      const method = PRESETS[preset] || `generate_${preset}`;
      if (typeof s[method] !== "function") {
        throw new Error(
          `Unknown preset "${preset}". Available: ${allPresets().join(", ")}`,
        );
      }
      s[method]();
    }

    if (params) applyParams(s, params);

    return { ...s.params };
  });
}

function applyParams(s, params) {
  const valid = new Set(parameterNames());
  for (const [name, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (!valid.has(name)) {
      throw new Error(
        `Unknown parameter "${name}". Call list_parameters for the full list.`,
      );
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`Parameter "${name}" must be a finite number.`);
    }
    // set_param clamps into the parameter's own range.
    s.set_param(name, value);
  }
}

/**
 * Nudge every parameter by a small random amount, in the spirit of Bfxr's
 * "Mutate" button. Unlike upstream we skip rectify_params(), which re-rolls the
 * base frequency outright — mutations here stay recognizably close to the source.
 * @param {object} params source parameters
 * @param {number} [amount] fraction of each parameter's range to move by
 * @param {number} [seed]
 */
export function mutateParams(params, amount = 0.1, seed) {
  const s = synth();
  const info = parameterInfo();

  return withRandom(seed, () => {
    s.reset_params();
    applyParams(s, params);

    // Same 10% chance of jumping to a different waveform as the web app.
    if (rng() < 0.1) {
      const count = Object.keys(WAVE_TYPES).length;
      const offset = Math.floor(rng() * (count - 1)) + 1;
      s.set_param("waveType", (s.get_param("waveType") + offset) % count);
      return { ...s.params };
    }

    for (const param of info) {
      if (param.type !== "number") continue;
      if (rng() < 0.5) continue;
      const range = param.max - param.min;
      const delta = (rng() - 0.5) * amount * range;
      s.set_param(param.name, s.get_param(param.name) + delta);
    }

    return { ...s.params };
  });
}

/**
 * Synthesize audio.
 * @param {object} params full parameter set
 * @param {number} [seed] noise waveforms are random; seed them to get identical audio back
 * @returns {{samples: Float32Array, duration: number}}
 */
export function render(params, seed) {
  const { Bfxr_DSP } = loadSandbox();
  return withRandom(seed, () => {
    // The DSP mutates the params it is handed (envelope clamping), so give it a copy.
    const dsp = new Bfxr_DSP({ ...params }, synth());
    dsp.generate_sound();
    const samples = dsp.buffer || new Float32Array(0);
    return { samples, duration: samples.length / 44100 };
  });
}

const PERMALINK_PREFIX = "https://www.bfxr.net/?sfx=";

/** Serialize to the `?sfx=` format bfxr.net reads (also the .bfxr param order). */
export function permalink(params, name = "sound") {
  const safeName = String(name).replace(/[~?&#]/g, "_") || "sound";
  const keys = Object.keys(defaultParams()).sort();
  const values = keys.map((key) => params[key]);
  const serialized = ["Bfxr", safeName, ...values].join("~");
  return PERMALINK_PREFIX + encodeURIComponent(serialized);
}

/** Inverse of permalink(); accepts a full URL or the bare `sfx` payload. */
export function parsePermalink(input) {
  let payload = String(input).trim();
  if (/^https?:\/\//i.test(payload)) {
    const url = new URL(payload);
    const sfx = url.searchParams.get("sfx");
    if (!sfx) throw new Error("URL has no ?sfx= parameter.");
    payload = sfx;
  } else if (payload.includes("%")) {
    payload = decodeURIComponent(payload);
  }

  const entries = payload.split("~");
  if (entries[0] !== "Bfxr") {
    throw new Error(
      `Only Bfxr sounds are supported (got synth "${entries[0]}").`,
    );
  }
  const name = entries[1];
  const keys = Object.keys(defaultParams()).sort();
  if (entries.length - 2 < keys.length) {
    throw new Error(
      `Malformed permalink: expected ${keys.length} values, got ${entries.length - 2}.`,
    );
  }
  const params = {};
  keys.forEach((key, i) => {
    params[key] = parseFloat(entries[i + 2]);
  });
  return { name, params };
}

/** The JSON body of a .bfxr file, as saved by the web app. */
export function toBfxrFile(params, name = "sound") {
  return JSON.stringify(
    {
      synth_type: "Bfxr",
      version: version(),
      file_name: name,
      params,
    },
    null,
    2,
  );
}

export function parseBfxrFile(text) {
  const data = JSON.parse(text);
  if (data.synth_type && data.synth_type !== "Bfxr") {
    throw new Error(
      `Only Bfxr sounds are supported (file is "${data.synth_type}").`,
    );
  }
  if (!data.params) throw new Error("File has no `params` object.");
  return { name: data.file_name || "sound", params: data.params };
}

/** Fill in defaults and clamp, so partial parameter sets are usable. */
export function completeParams(params) {
  const s = synth();
  s.reset_params();
  applyParams(s, params);
  return { ...s.params };
}
