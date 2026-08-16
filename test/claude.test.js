/**
 * Exercises the Claude designer against a stub Messages endpoint: no credentials
 * needed, but the request shape and response handling are real.
 */

import assert from "node:assert/strict";
import http from "node:http";
import test, { after, before } from "node:test";

import { WAVE_TYPES } from "../src/engine.js";

let server;
let lastRequest = null;
let reply = null;

function stubReply(text) {
  return {
    id: "msg_stub",
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    stop_reason: "end_turn",
    content: [{ type: "text", text }],
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}

before(async () => {
  server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      lastRequest = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const body = JSON.stringify(reply);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  delete process.env.BFXR_DESIGNER;
});

after(() => {
  server?.close();
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_BASE_URL;
});

test("sends a schema-constrained request and parses the design", async (t) => {
  const { designWithClaude, claudeAvailable } = await import("../src/claude.js");
  assert.equal(claudeAvailable(), true, "an API key counts as available");

  reply = stubReply(
    JSON.stringify({
      preset: "explosion",
      wave_type: "Bitnoise",
      name: "deep_boom",
      rationale: "Low noisy blast with a long decay.",
      params: [
        { name: "frequency_start", value: 0.12 },
        { name: "decayTime", value: 0.6 },
      ],
    }),
  );

  const design = await designWithClaude("a deep rumbling explosion");

  // Request shape
  assert.equal(lastRequest.model, "claude-opus-5");
  assert.equal(lastRequest.output_config.effort, "low");
  assert.equal(lastRequest.output_config.format.type, "json_schema");
  assert.equal(lastRequest.temperature, undefined, "no sampling params on Opus 5");
  assert.match(lastRequest.system, /Bfxr/);
  assert.match(lastRequest.system, /frequency_start/);
  assert.match(lastRequest.messages[0].content, /deep rumbling explosion/);

  const schema = lastRequest.output_config.format.schema;
  assert.ok(schema.properties.preset.enum.includes("explosion"));
  assert.ok(schema.properties.wave_type.enum.includes("auto"));
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, [
    "preset",
    "wave_type",
    "name",
    "rationale",
    "params",
  ]);
  const paramNames = schema.properties.params.items.properties.name.enum;
  assert.ok(paramNames.includes("bitCrush"));
  assert.ok(!paramNames.includes("waveType"), "waveType goes through wave_type");

  // Response handling
  assert.equal(design.preset, "explosion");
  assert.equal(design.name, "deep_boom");
  assert.equal(design.params.frequency_start, 0.12);
  assert.equal(design.params.decayTime, 0.6);
  assert.equal(design.params.waveType, WAVE_TYPES.Bitnoise);
});

test("'auto' waveform leaves the preset's choice alone", async () => {
  const { designWithClaude } = await import("../src/claude.js");
  reply = stubReply(
    JSON.stringify({
      preset: "jump",
      wave_type: "auto",
      name: "hop",
      rationale: "Default jump.",
      params: [],
    }),
  );
  const design = await designWithClaude("a jump");
  assert.equal(design.params.waveType, undefined);
  assert.deepEqual(design.params, {});
});

test("a refusal surfaces as an error so the caller can fall back", async () => {
  const { designWithClaude } = await import("../src/claude.js");
  reply = { ...stubReply("{}"), stop_reason: "refusal", content: [] };
  await assert.rejects(() => designWithClaude("something"), /declined/);
});
