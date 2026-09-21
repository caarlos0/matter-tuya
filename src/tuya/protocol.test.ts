import assert from "node:assert/strict";
import { createCipheriv, createHmac, randomBytes } from "node:crypto";
import { test } from "node:test";

import { crc32, decodeFrame, encodeFrame, type Version } from "./protocol.js";

const KEY = Buffer.from("0123456789abcdef");

/**
 * Builds the frame a device answers with.
 *
 * A request and a response are not the same shape: only a response carries a
 * return code before the body, so the two cannot be round-tripped against
 * each other.
 */
function response(
  sequence: number,
  command: number,
  body: Buffer,
  version: Version,
  key: Buffer,
  retcode = 0,
): Buffer {
  const code = Buffer.alloc(4);
  code.writeUInt32BE(retcode);

  if (version === "3.5") {
    const plaintext = Buffer.concat([code, body]);
    const header = Buffer.alloc(18);
    header.writeUInt32BE(0x6699);
    header.writeUInt32BE(sequence, 6);
    header.writeUInt32BE(command, 10);
    header.writeUInt32BE(plaintext.length + 28, 14);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-128-gcm", key, iv);
    cipher.setAAD(header.subarray(4));
    const sealed = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([
      header,
      iv,
      sealed,
      cipher.getAuthTag(),
      Buffer.from([0, 0, 0x99, 0x66]),
    ]);
  }

  const cipher = createCipheriv("aes-128-ecb", key, null);
  const sealed = Buffer.concat([cipher.update(body), cipher.final()]);
  const tail = version === "3.4" ? 36 : 8;
  const header = Buffer.alloc(16);
  header.writeUInt32BE(0x55aa);
  header.writeUInt32BE(sequence, 4);
  header.writeUInt32BE(command, 8);
  header.writeUInt32BE(4 + sealed.length + tail, 12);
  const framed = Buffer.concat([header, code, sealed]);
  const trailer = Buffer.alloc(tail);
  if (version === "3.4") {
    createHmac("sha256", key).update(framed).digest().copy(trailer);
  } else {
    trailer.writeUInt32BE(crc32(framed));
  }
  trailer.writeUInt32BE(0xaa55, tail - 4);
  return Buffer.concat([framed, trailer]);
}

/** The reference value every CRC-32 implementation agrees on. */
test("computes CRC-32", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
});

for (const version of ["3.3", "3.4", "3.5"] as Version[]) {
  test(`reads a ${version} response`, () => {
    const body = Buffer.from(JSON.stringify({ dps: { "1": true } }));
    const decoded = decodeFrame(
      response(7, 0x0a, body, version, KEY),
      version,
      KEY,
    );

    assert.equal(decoded.sequence, 7);
    assert.equal(decoded.command, 0x0a);
    assert.equal(
      decoded.payload.subarray(0, body.length).toString(),
      body.toString(),
    );
  });

  test(`rejects a corrupted ${version} response`, () => {
    const frame = response(1, 0x0a, Buffer.from("{}"), version, KEY);
    frame[frame.length - 6] = frame[frame.length - 6]! ^ 0xff;

    assert.throws(() => decodeFrame(frame, version, KEY));
  });

  test(`refuses to act on a ${version} rejection`, () => {
    const frame = response(
      1,
      0x0d,
      Buffer.from("data format error"),
      version,
      KEY,
      1,
    );

    assert.throws(() => decodeFrame(frame, version, KEY), /Tuya/);
  });
}

// Observed on the wire: a device that dislikes a write says so in the clear.
test("quotes the reason a device gives for refusing a frame", () => {
  const frame = response(
    1,
    0x0d,
    Buffer.from("data format error"),
    "3.5",
    KEY,
    1,
  );

  assert.throws(() => decodeFrame(frame, "3.5", KEY), /data format error/);
});

test("does not read a reason out of ciphertext", () => {
  const frame = response(1, 0x0d, randomBytes(64), "3.3", KEY, 1);

  assert.throws(() => decodeFrame(frame, "3.3", KEY), /Tuya return code 1$/);
});

test("rejects a response sealed with another key", () => {
  const frame = response(1, 0x0a, Buffer.from("{}"), "3.5", KEY);

  assert.throws(() =>
    decodeFrame(frame, "3.5", Buffer.from("fedcba9876543210")),
  );
});

test("frames a request with the prefix and suffix of its version", () => {
  const modern = encodeFrame(3, 0x10, Buffer.from("{}"), "3.5", KEY);
  assert.equal(modern.readUInt32BE(0), 0x6699);
  assert.equal(modern.readUInt32BE(modern.length - 4), 0x9966);
  assert.equal(modern.readUInt32BE(6), 3);
  assert.equal(modern.readUInt32BE(10), 0x10);
  assert.equal(modern.length, 22 + modern.readUInt32BE(14));

  const legacy = encodeFrame(3, 0x0a, Buffer.from("{}"), "3.3", KEY);
  assert.equal(legacy.readUInt32BE(0), 0x55aa);
  assert.equal(legacy.readUInt32BE(legacy.length - 4), 0xaa55);
  assert.equal(legacy.readUInt32BE(4), 3);
  assert.equal(legacy.readUInt32BE(8), 0x0a);
  assert.equal(legacy.length, 16 + legacy.readUInt32BE(12));
});
