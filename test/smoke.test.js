import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  allPresets,
  completeParams,
  makeParams,
  mutateParams,
  parameterInfo,
  parseBfxrFile,
  parsePermalink,
  permalink,
  render,
  toBfxrFile,
  version,
  WAVE_TYPES,
} from "../src/engine.js";
import { encodeWav } from "../src/wav.js";

test("every preset renders audible audio", () => {
  for (const preset of allPresets()) {
    for (const seed of [1, 2, 3]) {
      const params = makeParams({ preset, seed });
      const { samples, duration } = render(params);
      assert.ok(samples.length > 0, `${preset} produced no samples`);
      assert.ok(duration > 0.005, `${preset} is suspiciously short: ${duration}s`);
      const peak = samples.reduce((max, v) => Math.max(max, Math.abs(v)), 0);
      assert.ok(peak > 0.001, `${preset} is silent`);
      assert.ok(peak <= 1, `${preset} exceeds full scale`);
    }
  }
});

test("a seed reproduces the same sound", () => {
  const a = makeParams({ preset: "explosion", seed: 99 });
  const b = makeParams({ preset: "explosion", seed: 99 });
  assert.deepEqual(a, b);
  assert.deepEqual([...render(a, 99).samples], [...render(b, 99).samples]);
});

test("parameter overrides are applied and clamped", () => {
  const params = makeParams({
    preset: "tone",
    params: { frequency_start: 0.8, sustainTime: 5, waveType: WAVE_TYPES.Square },
  });
  assert.equal(params.frequency_start, 0.8);
  assert.equal(params.sustainTime, 1, "out-of-range values clamp to the max");
  assert.equal(params.waveType, WAVE_TYPES.Square);
});

test("unknown parameters are rejected", () => {
  assert.throws(
    () => makeParams({ preset: "tone", params: { nope: 1 } }),
    /Unknown parameter/,
  );
  assert.throws(() => makeParams({ preset: "nope" }), /Unknown preset/);
});

test("permalinks round-trip", () => {
  const params = makeParams({ preset: "laser_shoot", seed: 5 });
  const url = permalink(params, "zap");
  assert.ok(url.startsWith("https://www.bfxr.net/?sfx="));
  const loaded = parsePermalink(url);
  assert.equal(loaded.name, "zap");
  for (const [key, value] of Object.entries(params)) {
    assert.equal(loaded.params[key], value, `${key} did not survive the round-trip`);
  }
});

test(".bfxr files round-trip", () => {
  const params = makeParams({ preset: "powerup", seed: 3 });
  const loaded = parseBfxrFile(toBfxrFile(params, "yay"));
  assert.equal(loaded.name, "yay");
  assert.deepEqual(completeParams(loaded.params), params);
});

test("mutations stay close to the source", () => {
  const source = makeParams({ preset: "jump", seed: 11 });
  let moved = 0;
  for (let i = 0; i < 20; i++) {
    const mutated = mutateParams(source, 0.1, i);
    if (mutated.waveType !== source.waveType) continue; // the 10% waveform jump
    for (const { name, min, max, type } of parameterInfo()) {
      if (type !== "number") continue;
      const delta = Math.abs(mutated[name] - source[name]);
      assert.ok(
        delta <= 0.05 * (max - min) + 1e-9,
        `${name} moved ${delta}, further than half the mutation amount`,
      );
      if (delta > 0) moved++;
    }
  }
  assert.ok(moved > 0, "nothing mutated at all");
});

test("wav encoding produces a valid 16-bit mono header", () => {
  const { samples } = render(makeParams({ preset: "pickup_coin", seed: 1 }));
  const wav = encodeWav(samples);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.readUInt16LE(20), 1, "PCM");
  assert.equal(wav.readUInt16LE(22), 1, "mono");
  assert.equal(wav.readUInt32LE(24), 44100);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(4), wav.length - 8);
  assert.equal(wav.readUInt32LE(40), samples.length * 2);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bfxr-"));
  const file = path.join(dir, "coin.wav");
  fs.writeFileSync(file, wav);
  assert.equal(fs.statSync(file).size, wav.length);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("engine reports the vendored DSP version", () => {
  assert.match(version(), /^\d+\.\d+\.\d+$/);
});
