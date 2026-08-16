/**
 * Optional prompt designer backed by the Claude API. When credentials are
 * available, a plain-English request is turned into real Bfxr parameters by the
 * model instead of the keyword mapper in design.js.
 *
 * Everything here degrades gracefully: no SDK, no credentials, or any API error
 * falls back to the keyword designer.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { allPresets, parameterInfo, WAVE_TYPES } from "./engine.js";

const MODEL = "claude-opus-5";

let clientPromise = null;

function hasCredentials() {
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
    return true;
  }
  // `ant auth login` stores a profile the SDK picks up with no env var set.
  const configDir =
    process.env.ANTHROPIC_CONFIG_DIR ||
    path.join(os.homedir(), ".config", "anthropic");
  return fs.existsSync(path.join(configDir, "credentials"));
}

export function claudeAvailable() {
  if (process.env.BFXR_DESIGNER === "keywords") return false;
  return hasCredentials();
}

async function getClient() {
  if (!clientPromise) {
    clientPromise = import("@anthropic-ai/sdk")
      .then((mod) => new (mod.default || mod.Anthropic)())
      .catch((error) => {
        console.error("[bfxr] Claude SDK unavailable:", error.message);
        return null;
      });
  }
  return clientPromise;
}

function schema() {
  const numericParams = parameterInfo()
    .filter((p) => p.type === "number")
    .map((p) => p.name);

  return {
    type: "object",
    properties: {
      preset: {
        type: "string",
        enum: allPresets(),
        description: "Closest starting point for the requested sound.",
      },
      wave_type: {
        type: "string",
        enum: ["auto", ...Object.keys(WAVE_TYPES)],
        description: "Waveform, or 'auto' to keep the preset's choice.",
      },
      name: {
        type: "string",
        description: "Short snake_case filename, e.g. deep_coin_pickup.",
      },
      rationale: {
        type: "string",
        description: "One short sentence on the choices made.",
      },
      params: {
        type: "array",
        description: "Parameter overrides applied on top of the preset.",
        items: {
          type: "object",
          properties: {
            name: { type: "string", enum: numericParams },
            value: { type: "number" },
          },
          required: ["name", "value"],
          additionalProperties: false,
        },
      },
    },
    required: ["preset", "wave_type", "name", "rationale", "params"],
    additionalProperties: false,
  };
}

function systemPrompt() {
  const lines = parameterInfo()
    .filter((p) => p.type === "number")
    .map(
      (p) =>
        `- ${p.name} (${p.min}..${p.max}, default ${p.default}): ${p.description}`,
    );

  return [
    "You are a sound designer driving Bfxr, the 8-bit game sound effect synth.",
    "Given a description of a sound effect, choose the closest preset and the parameter overrides that get it there.",
    "",
    `Presets: ${allPresets().join(", ")}. Use 'tone' (a bare waveform) when nothing else fits.`,
    `Waveforms: ${Object.keys(WAVE_TYPES).join(", ")}.`,
    "",
    "Parameters:",
    ...lines,
    "",
    "Guidance:",
    "- Only override parameters the description actually calls for; presets already randomize sensibly.",
    "- frequency_start is pitch on a squared scale: ~0.1 is very low, 0.3 is mid, 0.7+ is shrill.",
    "- Total length comes from attackTime + sustainTime + decayTime; most effects want under 0.5 total.",
    "- Reach for bitCrush for lo-fi grit, lpFilterCutoff to muffle, overtones to thicken, vibrato* to wobble, repeatSpeed to stutter.",
    "- Keep names short, lowercase and snake_case.",
  ].join("\n");
}

/**
 * @param {string} prompt
 * @returns {Promise<{preset: string, params: object, name: string, rationale: string}>}
 * @throws if the API is unreachable or declines — callers fall back to the keyword designer.
 */
export async function designWithClaude(prompt) {
  const client = await getClient();
  if (!client) throw new Error("Claude SDK not installed");

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4000,
    system: systemPrompt(),
    output_config: {
      effort: "low",
      format: { type: "json_schema", schema: schema() },
    },
    messages: [
      { role: "user", content: `Design this sound effect: ${prompt}` },
    ],
  });

  if (response.stop_reason === "refusal") {
    throw new Error("Claude declined this request");
  }

  const text = response.content.find((block) => block.type === "text")?.text;
  if (!text) throw new Error("Claude returned no output");

  const design = JSON.parse(text);
  const params = {};
  for (const { name, value } of design.params || []) {
    params[name] = value;
  }
  if (design.wave_type && design.wave_type !== "auto") {
    params.waveType = WAVE_TYPES[design.wave_type];
  }

  return {
    preset: design.preset,
    params,
    name: design.name,
    rationale: design.rationale,
  };
}
