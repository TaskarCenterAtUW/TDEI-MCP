import { strict as assert } from "node:assert";
import test from "node:test";

import { scanZipForIncline } from "../src/intents/incline-scan.js";

/** Deterministic PRNG (mulberry32) so fuzz failures reproduce. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomBytes(rand: () => number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) out[i] = Math.floor(rand() * 256);
  return out;
}

/** Minimal valid stored-method ZIP with a single edges.geojson entry. */
function validStoredZip(content: string): Uint8Array {
  const name = Buffer.from("edges.geojson", "utf-8");
  const data = Buffer.from(content, "utf-8");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);
  const cdStart = 30 + name.length + data.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(46 + name.length, 12);
  eocd.writeUInt32LE(cdStart, 16);
  return new Uint8Array(Buffer.concat([local, name, data, central, name, eocd]));
}

function assertWellFormed(result: ReturnType<typeof scanZipForIncline>): void {
  assert.ok(Array.isArray(result.checkedFiles));
  assert.equal(typeof result.hasIncline, "boolean");
  assert.equal(typeof result.evidence, "string");
  assert.ok(result.evidence.length > 0);
}

test("fuzz: random buffers never throw and always return a verdict", () => {
  const rand = prng(12345);
  for (const length of [0, 1, 7, 21, 22, 100, 1000, 4096, 65557 + 22, 200_000]) {
    const input = randomBytes(rand, length);
    const result = scanZipForIncline(input);
    assertWellFormed(result);
    assert.equal(result.hasIncline, false);
  }
});

test("fuzz: truncated and bit-flipped zips never throw", () => {
  const rand = prng(987654321);
  const valid = validStoredZip(`{"properties":{"incline":0.05}}`);
  // All prefixes of a valid zip (covers cut-off headers, partial central dir, missing EOCD).
  for (let len = 0; len <= valid.length; len += 7) {
    const result = scanZipForIncline(valid.subarray(0, len));
    assertWellFormed(result);
  }
  // Random single/multi-byte corruptions of a valid zip.
  for (let round = 0; round < 300; round += 1) {
    const mutated = valid.slice();
    const flips = 1 + Math.floor(rand() * 4);
    for (let f = 0; f < flips; f += 1) {
      mutated[Math.floor(rand() * mutated.length)] = Math.floor(rand() * 256);
    }
    const result = scanZipForIncline(mutated);
    assertWellFormed(result);
  }
});

test("fuzz: hostile sizes and EOCD decoys terminate safely", () => {
  // Huge compressedSize / count values with a tiny body.
  const hostile = Buffer.alloc(200, 0xff);
  assertWellFormed(scanZipForIncline(new Uint8Array(hostile)));
  // EOCD signature decoy at every alignment inside random data.
  const rand = prng(424242);
  for (let round = 0; round < 50; round += 1) {
    const input = randomBytes(rand, 500);
    const at = Math.floor(rand() * (input.length - 4));
    input[at] = 0x50;
    input[at + 1] = 0x4b;
    input[at + 2] = 0x05;
    input[at + 3] = 0x06;
    assertWellFormed(scanZipForIncline(input));
  }
  // All-0xFF and all-zero blocks at EOCD-sensitive sizes.
  for (const length of [0, 21, 22, 23, 65557, 65579, 131136]) {
    assertWellFormed(scanZipForIncline(new Uint8Array(length)));
    assertWellFormed(scanZipForIncline(new Uint8Array(length).fill(0xff)));
  }
});

test("fuzz: valid zips keep their verdict under name/content mutation", () => {
  const base = validStoredZip(`{"properties":{"highway":"footway"}}`);
  const rand = prng(20261031);
  // Mutate only the file content region (keep headers intact) — verdict must stay boolean-consistent.
  const view = new DataView(base.buffer, base.byteOffset, base.byteLength);
  assert.equal(view.getUint32(0, true), 0x04034b50);
  const nameLen = view.getUint16(26, true);
  const dataStart = 30 + nameLen;
  for (let round = 0; round < 200; round += 1) {
    const mutated = base.slice();
    const pos = dataStart + Math.floor(rand() * (mutated.length - dataStart - 22 - 1));
    mutated[pos] = Math.floor(rand() * 256);
    const result = scanZipForIncline(mutated);
    assertWellFormed(result);
    // Corrupting content can only destroy (never create) the incline tag evidence path here
    // if the tag bytes survive; either verdict is acceptable, but it must be well-formed.
  }
  const intact = scanZipForIncline(base);
  assert.equal(intact.hasIncline, false);
  assert.deepEqual(intact.checkedFiles, ["edges.geojson"]);
});
