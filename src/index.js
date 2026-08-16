#!/usr/bin/env node
/**
 * bfxr-mcp — an MCP server around the Bfxr sound-effect synth.
 *
 * Tools generate 8-bit style game sound effects and write them to disk as WAV
 * files, plus a bfxr.net permalink so a human can open and tweak the result.
 */

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
  allPresets,
  completeParams,
  defaultParams,
  makeParams,
  mutateParams,
  parameterInfo,
  parseBfxrFile,
  parsePermalink,
  version,
  WAVE_NAMES,
  WAVE_TYPES,
} from "./engine.js";
import { createSound } from "./sounds.js";
import { playFile, resolveOutputDir, safeName } from "./output.js";

const PRESET_LIST = allPresets().join(", ");
const PARAM_NAMES = parameterInfo().map((p) => p.name);

const paramsSchema = z
  .record(z.string(), z.number())
  .describe(
    "Bfxr parameter overrides, applied on top of the preset. Any of: " +
      PARAM_NAMES.join(", ") +
      ". Call list_parameters for ranges and meanings.",
  );

/** Compact, readable summary of a sound: only what differs from the defaults. */
function describeParams(params) {
  const defaults = defaultParams();
  const out = {};
  for (const [name, value] of Object.entries(params)) {
    if (name === "waveType") {
      out.waveType = `${WAVE_NAMES[value] || value} (${value})`;
      continue;
    }
    if (Math.abs(value - defaults[name]) > 1e-6) {
      out[name] = Math.round(value * 10000) / 10000;
    }
  }
  return out;
}

function writeSound({ params, name, dir, saveBfxr, seed, preset, prompt }) {
  const entry = createSound({
    params,
    name,
    dir,
    seed,
    saveBfxr,
    preset,
    prompt,
    source: "mcp",
  });

  const result = {
    file: path.join(dir, entry.file),
    duration_seconds: entry.duration,
    permalink: entry.permalink,
    params: describeParams(params),
  };
  if (entry.bfxr_file) result.bfxr_file = path.join(dir, entry.bfxr_file);
  return result;
}

function toContent(results, dir, notes = []) {
  const summary = {
    output_dir: dir,
    count: results.length,
    sounds: results,
  };
  if (notes.length) summary.notes = notes;
  return {
    content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
  };
}

function audioBlocks(results) {
  return results.map((r) => ({
    type: "audio",
    data: fs.readFileSync(r.file).toString("base64"),
    mimeType: "audio/wav",
  }));
}

const server = new McpServer({
  name: "bfxr",
  version: "0.1.0",
});

server.registerTool(
  "generate_sound",
  {
    title: "Generate a game sound effect",
    description: [
      "Synthesize a retro/8-bit game sound effect with the Bfxr engine and save it as a .wav file.",
      "",
      `Presets: ${PRESET_LIST}.`,
      "Pick the preset closest to what was asked for, then shape it with `params`:",
      "- coin/pickup/collect -> pickup_coin; laser/shoot/zap -> laser_shoot; explosion/boom -> explosion",
      "- powerup/level-up -> powerup; damage/hurt/impact -> hit_hurt; jump/hop -> jump; UI click/menu blip -> blip_select",
      "- anything else -> start from `tone` (a plain sine) or `random` and set params by hand.",
      "Useful shaping params: frequency_start (pitch), frequency_slide (up/down glide), sustainTime + decayTime (length),",
      "sustainPunch (attack pop), lpFilterCutoff (muffle), bitCrush (lo-fi crunch), vibratoDepth/Speed, overtones (thicker).",
      "",
      "Never set play or embed_audio, and never call play_sound — the user always plays sounds in the library UI.",
      "Prefer count=3..5, then report file paths. After writing, refresh the library in Cursor at http://localhost:4747.",
      "Each sound comes back with a bfxr.net permalink the user can open to tweak it by ear.",
    ].join("\n"),
    inputSchema: {
      name: z
        .string()
        .optional()
        .describe("Base filename, e.g. 'coin' -> coin.wav. Default: the preset name."),
      preset: z
        .string()
        .optional()
        .describe(`Starting point. One of: ${PRESET_LIST}. Default: tone.`),
      wave_type: z
        .enum(Object.keys(WAVE_TYPES))
        .optional()
        .describe("Waveform by name. Overrides the preset's choice."),
      params: paramsSchema.optional(),
      count: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe("How many variations to generate (presets are randomized). Default 1."),
      seed: z
        .number()
        .int()
        .optional()
        .describe("Seed the randomization so the same call reproduces the same sound(s)."),
      output_dir: z
        .string()
        .optional()
        .describe("Where to write files. Default: $BFXR_OUTPUT_DIR or ~/Downloads/bfxr-sounds."),
      save_bfxr: z
        .boolean()
        .optional()
        .describe("Also write a .bfxr project file next to each .wav. Default false."),
      play: z
        .boolean()
        .optional()
        .describe("Do not set this. The user plays sounds in the library UI."),
      embed_audio: z
        .boolean()
        .optional()
        .describe("Do not set this. The user plays sounds in the library UI."),
    },
  },
  async (args) => {
    const dir = resolveOutputDir(args.output_dir);
    const count = args.count ?? 1;
    const preset = args.preset ?? "tone";
    const base = safeName(args.name || preset, "sound");

    const overrides = { ...(args.params || {}) };
    if (args.wave_type) overrides.waveType = WAVE_TYPES[args.wave_type];

    const results = [];
    for (let i = 0; i < count; i++) {
      const seed = args.seed === undefined ? undefined : args.seed + i;
      const params = makeParams({ preset, params: overrides, seed });
      const name = count === 1 ? base : `${base}-${i + 1}`;
      results.push(
        writeSound({
          params,
          name,
          dir,
          saveBfxr: args.save_bfxr === true,
          seed,
          preset,
        }),
      );
    }

    const notes = [];
    if (args.play) {
      for (const result of results) {
        const played = await playFile(result.file);
        if (!played.played) {
          notes.push(`Could not play audio: ${played.error}`);
          break;
        }
      }
    }

    const response = toContent(results, dir, notes);
    if (args.embed_audio) response.content.push(...audioBlocks(results));
    return response;
  },
);

server.registerTool(
  "mutate_sound",
  {
    title: "Make variations of an existing sound",
    description: [
      "Nudge every parameter of an existing sound by a small random amount to produce close variations —",
      "the 'Mutate' button in Bfxr. Use this when the user likes a sound but wants it 'a bit different'.",
      "Give the source as a bfxr.net permalink, a path to a .wav generated by this server's sibling .bfxr file,",
      "a path to a .bfxr file, or a raw params object.",
      "Never set play or embed_audio, and never call play_sound — the user plays sounds in the library UI.",
      "After writing, refresh the library in Cursor at http://localhost:4747.",
    ].join("\n"),
    inputSchema: {
      source: z
        .string()
        .optional()
        .describe("A bfxr.net permalink (or ?sfx= payload), or a path to a .bfxr file."),
      params: paramsSchema
        .optional()
        .describe("Source parameters, if you have them instead of a permalink/file."),
      amount: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Mutation strength as a fraction of each parameter's range. Default 0.1."),
      count: z.number().int().min(1).max(10).optional().describe("How many variations. Default 3."),
      name: z.string().optional().describe("Base filename for the variations."),
      seed: z.number().int().optional().describe("Seed for reproducible mutations."),
      output_dir: z.string().optional(),
      save_bfxr: z.boolean().optional(),
      play: z
        .boolean()
        .optional()
        .describe("Do not set this. The user plays sounds in the library UI."),
      embed_audio: z
        .boolean()
        .optional()
        .describe("Do not set this. The user plays sounds in the library UI."),
    },
  },
  async (args) => {
    const source = loadSource(args);
    const dir = resolveOutputDir(args.output_dir);
    const count = args.count ?? 3;
    const base = safeName(args.name || source.name || "mutation", "mutation");

    const results = [];
    for (let i = 0; i < count; i++) {
      const seed = args.seed === undefined ? undefined : args.seed + i;
      const params = mutateParams(source.params, args.amount ?? 0.1, seed);
      results.push(
        writeSound({
          params,
          name: `${base}-mut${i + 1}`,
          dir,
          saveBfxr: args.save_bfxr === true,
          seed,
        }),
      );
    }

    const notes = [];
    if (args.play) {
      for (const result of results) {
        const played = await playFile(result.file);
        if (!played.played) {
          notes.push(`Could not play audio: ${played.error}`);
          break;
        }
      }
    }

    const response = toContent(results, dir, notes);
    if (args.embed_audio) response.content.push(...audioBlocks(results));
    return response;
  },
);

function loadSource(args) {
  if (args.params && Object.keys(args.params).length > 0) {
    return { name: null, params: completeParams(args.params) };
  }
  if (!args.source) {
    throw new Error("Provide either `source` (permalink or .bfxr path) or `params`.");
  }
  const value = args.source.trim();
  if (!/^https?:\/\//i.test(value) && !value.startsWith("Bfxr~")) {
    const filePath = path.resolve(value);
    if (!fs.existsSync(filePath)) {
      throw new Error(`No such file: ${filePath}`);
    }
    const loaded = parseBfxrFile(fs.readFileSync(filePath, "utf8"));
    return { name: loaded.name, params: completeParams(loaded.params) };
  }
  const loaded = parsePermalink(value);
  return { name: loaded.name, params: completeParams(loaded.params) };
}

server.registerTool(
  "load_sound",
  {
    title: "Read a sound's parameters",
    description:
      "Decode a bfxr.net permalink or a .bfxr file into its parameters, optionally re-rendering it to a .wav. " +
      "Use this to inspect or edit a sound the user shares.",
    inputSchema: {
      source: z
        .string()
        .describe("A bfxr.net permalink (or ?sfx= payload), or a path to a .bfxr file."),
      render_wav: z
        .boolean()
        .optional()
        .describe("Also write the sound out as a .wav. Default false."),
      name: z.string().optional().describe("Base filename when render_wav is set."),
      output_dir: z.string().optional(),
    },
  },
  async (args) => {
    const loaded = loadSource({ source: args.source });
    const payload = {
      name: loaded.name,
      params: loaded.params,
      summary: describeParams(loaded.params),
    };

    if (args.render_wav) {
      const dir = resolveOutputDir(args.output_dir);
      const base = safeName(args.name || loaded.name || "sound", "sound");
      const written = writeSound({
        params: loaded.params,
        name: base,
        dir,
        saveBfxr: false,
      });
      payload.file = written.file;
      payload.duration_seconds = written.duration_seconds;
    }

    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    };
  },
);

server.registerTool(
  "list_parameters",
  {
    title: "List Bfxr parameters and presets",
    description:
      "Every Bfxr parameter with its range, default and what it does, plus the available presets and waveforms. " +
      "Read this before hand-crafting a sound with `params`.",
    inputSchema: {},
  },
  async () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            engine_version: version(),
            presets: allPresets(),
            wave_types: WAVE_TYPES,
            parameters: parameterInfo(),
          },
          null,
          2,
        ),
      },
    ],
  }),
);

server.registerTool(
  "play_sound",
  {
    title: "Play a sound file",
    description:
      "Do not call this. The user always plays sounds in the library web app. " +
      "Only use if they explicitly ask you to play through the machine speakers.",
    inputSchema: {
      file: z.string().describe("Path to the .wav file to play."),
    },
  },
  async (args) => {
    const filePath = path.resolve(args.file);
    if (!fs.existsSync(filePath)) {
      throw new Error(`No such file: ${filePath}`);
    }
    const result = await playFile(filePath);
    return {
      content: [
        {
          type: "text",
          text: result.played
            ? `Played ${filePath} with ${result.player}.`
            : `Could not play ${filePath}: ${result.error}`,
        },
      ],
      isError: !result.played,
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`bfxr-mcp ready (Bfxr DSP ${version()})`);
