#!/usr/bin/env node
/**
 * Block speaker playback from the agent. The user auditions sounds in the
 * library web app.
 */
import fs from "node:fs";

const mode = process.argv[2] || "before-mcp";
const DENY_PLAY = {
  permission: "deny",
  agent_message:
    "Do not play audio. The user plays sounds in the library web app. Retry without play_sound, play, or embed_audio.",
  user_message: "Blocked auto-play — use the library UI instead.",
};

function readInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function toolName(data) {
  return String(data.tool_name || data.toolName || "");
}

function toolInput(data) {
  const value = data.tool_input ?? data.arguments ?? data.input;
  if (value && typeof value === "object") return { ...value };
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      /* ignore */
    }
  }
  return {};
}

function isPlaySound(name) {
  return /(^|:)play_sound$/.test(name);
}

function isSoundWrite(name) {
  return /(^|:)generate_sound$/.test(name) || /(^|:)mutate_sound$/.test(name);
}

function reply(payload) {
  process.stdout.write(JSON.stringify(payload));
}

const data = readInput();
const name = toolName(data);
const input = toolInput(data);

if (mode === "after-write") {
  reply({
    additional_context:
      "Do not play these sounds. Refresh the library web app in Cursor Simple Browser / Browser pane at http://localhost:4747 so the user can play them. Start it with `npm run web` if it is not running.",
  });
  process.exit(0);
}

if (isPlaySound(name)) {
  reply(DENY_PLAY);
  process.exit(0);
}

if (isSoundWrite(name) && (input.play === true || input.embed_audio === true)) {
  if (mode === "pre-tool") {
    const updated = { ...input, play: false, embed_audio: false };
    reply({ permission: "allow", updated_input: updated });
    process.exit(0);
  }
  reply(DENY_PLAY);
  process.exit(0);
}

reply({ permission: "allow" });
