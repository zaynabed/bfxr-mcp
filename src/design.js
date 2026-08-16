/**
 * Turns a plain-English request ("deep squelchy laser") into a Bfxr preset plus
 * parameter tweaks, with no model in the loop. Deterministic, instant, offline —
 * and the fallback whenever the Claude designer isn't available.
 */

import { WAVE_TYPES } from "./engine.js";

/** preset -> words that suggest it. Longest phrase wins ties. */
const CATEGORIES = [
  ["pickup_coin", ["coin", "pickup", "pick up", "collect", "ding", "reward", "gem", "point", "score", "treasure", "loot", "item"]],
  ["laser_shoot", ["laser", "shoot", "shot", "pew", "zap", "blaster", "gun", "fire", "beam", "plasma", "ray", "missile", "projectile"]],
  ["explosion", ["explosion", "explode", "boom", "bomb", "blast", "crash", "smash", "shatter", "thunder", "detonate", "wreck", "destroy"]],
  ["powerup", ["powerup", "power up", "power-up", "level up", "levelup", "upgrade", "win", "victory", "fanfare", "success", "achievement", "heal", "buff", "unlock", "complete"]],
  ["hit_hurt", ["hit", "hurt", "damage", "punch", "ouch", "thud", "bonk", "slap", "kick", "impact", "hurt", "wound", "crunch", "footstep", "step", "stomp"]],
  ["jump", ["jump", "hop", "leap", "bounce", "spring", "boing", "launch"]],
  ["blip_select", ["blip", "click", "select", "menu", "ui", "beep", "button", "cursor", "tick", "type", "keyboard", "notification", "toggle", "confirm", "cancel", "error", "alert"]],
];

/**
 * Each modifier gets the current params and mutates them. `scale`/`bump` clamp
 * on the way out via the engine's set_param, so overshoot is harmless.
 */
const MODIFIERS = [
  {
    words: ["low", "deep", "bass", "heavy", "dark", "big", "huge", "massive", "fat", "boomy", "sub"],
    apply: (p) => {
      p.frequency_start = (p.frequency_start ?? 0.3) * 0.5;
    },
    note: "lower pitch",
  },
  {
    words: ["high", "bright", "tinny", "small", "tiny", "sharp", "light", "squeaky", "thin", "shrill", "cute"],
    apply: (p) => {
      p.frequency_start = (p.frequency_start ?? 0.3) * 1.8;
    },
    note: "higher pitch",
  },
  {
    words: ["long", "slow", "sustained", "drawn out", "lingering", "big", "epic", "drone"],
    apply: (p) => {
      p.sustainTime = (p.sustainTime ?? 0.2) * 1.7 + 0.05;
      p.decayTime = (p.decayTime ?? 0.3) * 1.8 + 0.1;
    },
    note: "longer envelope",
  },
  {
    words: ["short", "quick", "snappy", "tight", "fast", "staccato", "brief", "subtle", "tiny"],
    apply: (p) => {
      p.sustainTime = (p.sustainTime ?? 0.2) * 0.45;
      p.decayTime = (p.decayTime ?? 0.3) * 0.45;
    },
    note: "shorter envelope",
  },
  {
    words: ["soft", "muffled", "muted", "dull", "warm", "underwater", "distant", "gentle", "smooth"],
    apply: (p) => {
      p.lpFilterCutoff = Math.min(p.lpFilterCutoff ?? 1, 0.3);
    },
    note: "low-pass filtered",
  },
  {
    words: ["harsh", "gritty", "crunchy", "lofi", "lo-fi", "8-bit", "8bit", "retro", "dirty", "crushed", "glitchy", "chiptune", "nes", "gameboy"],
    apply: (p) => {
      p.bitCrush = Math.min(1, (p.bitCrush ?? 0) + 0.35);
    },
    note: "bit-crushed",
  },
  {
    words: ["punchy", "pop", "snap", "thump", "percussive", "hard"],
    apply: (p) => {
      p.sustainPunch = Math.min(1, (p.sustainPunch ?? 0) + 0.45);
    },
    note: "more punch",
  },
  {
    words: ["metallic", "metal", "clang", "ring", "ringing", "bell", "glassy", "chime", "rich", "thick"],
    apply: (p) => {
      p.overtones = Math.min(1, (p.overtones ?? 0) + 0.4);
      p.overtoneFalloff = Math.min(1, (p.overtoneFalloff ?? 0) + 0.3);
    },
    note: "added harmonics",
  },
  {
    words: ["wobbly", "warble", "wavy", "vibrato", "shaky", "shimmer", "quiver"],
    apply: (p) => {
      p.vibratoDepth = Math.min(1, (p.vibratoDepth ?? 0) + 0.45);
      p.vibratoSpeed = Math.min(1, (p.vibratoSpeed ?? 0) + 0.5);
    },
    note: "vibrato",
  },
  {
    words: ["echo", "stutter", "repeat", "repeating", "machine gun", "rapid", "rattle", "chatter"],
    apply: (p) => {
      p.repeatSpeed = Math.min(1, (p.repeatSpeed ?? 0) + 0.55);
    },
    note: "repeating",
  },
  {
    words: ["rising", "up", "upward", "ascending", "sweep up", "charge"],
    apply: (p) => {
      p.frequency_slide = Math.abs(p.frequency_slide ?? 0.2) + 0.15;
    },
    note: "pitch rises",
  },
  {
    words: ["falling", "down", "downward", "descending", "sweep down", "drop", "fail", "lose", "death", "die", "game over", "sad"],
    apply: (p) => {
      p.frequency_slide = -Math.abs(p.frequency_slide ?? 0.2) - 0.15;
    },
    note: "pitch falls",
  },
  {
    words: ["noisy", "noise", "static", "hiss", "whoosh", "wind", "air", "swoosh", "sand", "gravel", "crackle"],
    apply: (p) => {
      p.waveType = WAVE_TYPES.White;
    },
    note: "white noise",
  },
  {
    words: ["alien", "weird", "strange", "sci-fi", "scifi", "robot", "robotic", "computer", "digital", "electronic"],
    apply: (p) => {
      p.flangerOffset = 0.3;
      p.flangerSweep = -0.2;
      p.bitCrush = Math.min(1, (p.bitCrush ?? 0) + 0.2);
    },
    note: "flanger + crush",
  },
  {
    words: ["squelch", "squelchy", "wet", "squishy", "slime", "goo", "blob"],
    apply: (p) => {
      p.frequency_slide = -0.25;
      p.lpFilterCutoff = Math.min(p.lpFilterCutoff ?? 1, 0.45);
      p.vibratoDepth = Math.min(1, (p.vibratoDepth ?? 0) + 0.3);
      p.vibratoSpeed = Math.min(1, (p.vibratoSpeed ?? 0) + 0.6);
    },
    note: "wet wobble",
  },
];

/** Explicit waveform requests, e.g. "square wave beep". */
const WAVE_WORDS = {
  sine: "Sin",
  sin: "Sin",
  square: "Square",
  saw: "Saw",
  sawtooth: "Saw",
  triangle: "Triangle",
  tri: "Triangle",
  whistle: "Whistle",
  tan: "Tan",
  breaker: "Breaker",
  rasp: "Rasp",
  buzz: "Rasp",
  voice: "Voice",
  vocal: "Voice",
  bitnoise: "Bitnoise",
  fm: "FMSyn",
  fmsyn: "FMSyn",
};

function contains(text, phrase) {
  // Word-boundary match so "hit" doesn't fire inside "white".
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(text);
}

function pickPreset(text) {
  let best = { preset: "tone", score: 0 };
  for (const [preset, words] of CATEGORIES) {
    let score = 0;
    for (const word of words) {
      // Longer phrases are stronger evidence than single words.
      if (contains(text, word)) score += word.includes(" ") ? 3 : 2;
    }
    if (score > best.score) best = { preset, score };
  }
  return best.preset;
}

/**
 * @param {string} prompt
 * @returns {{preset: string, params: object, name: string, rationale: string}}
 */
export function designFromPrompt(prompt) {
  const text = ` ${String(prompt || "").toLowerCase()} `;
  const preset = pickPreset(text);
  const params = {};
  const notes = [];

  for (const modifier of MODIFIERS) {
    if (modifier.words.some((word) => contains(text, word))) {
      modifier.apply(params);
      notes.push(modifier.note);
    }
  }

  for (const [word, wave] of Object.entries(WAVE_WORDS)) {
    if (contains(text, word)) {
      params.waveType = WAVE_TYPES[wave];
      notes.push(`${wave} wave`);
      break;
    }
  }

  // A bare "tone" with no shaping is a dull deliverable — give it an envelope.
  if (preset === "tone" && params.sustainTime === undefined) {
    params.sustainTime = 0.15;
    params.decayTime = 0.35;
  }

  return {
    preset,
    params,
    name: nameFromPrompt(prompt, preset),
    rationale: notes.length
      ? `${preset.replace("_", "/")} + ${notes.join(", ")}`
      : preset.replace("_", "/"),
  };
}

export function nameFromPrompt(prompt, fallback = "sound") {
  const words = String(prompt || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4);
  return words.length ? words.join("_") : fallback;
}
