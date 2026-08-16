import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, "..", ".cursor", "hooks", "bfxr-mcp.js");

function runHook(mode, payload) {
  const result = spawnSync(process.execPath, [HOOK, mode], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("denies play_sound", () => {
  const out = runHook("before-mcp", { tool_name: "play_sound", tool_input: {} });
  assert.equal(out.permission, "deny");
});

test("strips play flags on generate_sound", () => {
  const out = runHook("pre-tool", {
    tool_name: "MCP:generate_sound",
    tool_input: { preset: "explosion", play: true, embed_audio: true },
  });
  assert.equal(out.permission, "allow");
  assert.equal(out.updated_input.play, false);
  assert.equal(out.updated_input.embed_audio, false);
  assert.equal(out.updated_input.preset, "explosion");
});

test("after a write, reminds the agent to refresh the library and not play", () => {
  const out = runHook("after-write", {
    tool_name: "MCP:generate_sound",
    tool_input: { preset: "jump" },
  });
  assert.match(out.additional_context, /Refresh the library/);
  assert.match(out.additional_context, /Do not play/);
});
