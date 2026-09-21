import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { createConnection, type Socket } from "node:net";

/**
 * Speaks the Tuya protocol on the local network, on port 6668.
 *
 * Version 3.5 frames with 0x00006699 and AES-128-GCM; the older versions
 * frame with 0x000055AA and AES-128-ECB. Versions 3.4 and 3.5 negotiate a
 * session key first. The wire format follows tinytuya, which documents it:
 * github.com/jasonacox/tinytuya/tree/master/tinytuya/core
 */

export type Version = "3.1" | "3.3" | "3.4" | "3.5";

export const VERSIONS: Version[] = ["3.5", "3.4", "3.3", "3.1"];

type Frame = { sequence: number; command: number; payload: Buffer };

const SESSION_START = 0x03;
const SESSION_FINISH = 0x05;
const CONTROL = 0x07;
const STATUS = 0x08;
const QUERY = 0x0a;
const CONTROL_NEW = 0x0d;
const QUERY_NEW = 0x10;

/** Commands that carry no version header. Every other command needs one. */
const BARE_COMMANDS = new Set([
  SESSION_START,
  SESSION_FINISH,
  QUERY,
  QUERY_NEW,
]);

function decryptEcb(payload: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(payload), decipher.final()]);
}

function encryptEcb(payload: Buffer, key: Buffer, padding = true): Buffer {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  cipher.setAutoPadding(padding);
  return Buffer.concat([cipher.update(payload), cipher.final()]);
}

export function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function encodeFrame(
  sequence: number,
  command: number,
  payload: Buffer,
  version: Version,
  key: Buffer,
): Buffer {
  if (version === "3.5") {
    const header = Buffer.alloc(18);
    header.writeUInt32BE(0x6699);
    header.writeUInt32BE(sequence, 6);
    header.writeUInt32BE(command, 10);
    header.writeUInt32BE(payload.length + 28, 14);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-128-gcm", key, iv);
    cipher.setAAD(header.subarray(4));
    const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
    return Buffer.concat([
      header,
      iv,
      encrypted,
      cipher.getAuthTag(),
      Buffer.from([0, 0, 0x99, 0x66]),
    ]);
  }

  const encrypted = version === "3.1" ? payload : encryptEcb(payload, key);
  const header = Buffer.alloc(16);
  header.writeUInt32BE(0x55aa);
  header.writeUInt32BE(sequence, 4);
  header.writeUInt32BE(command, 8);
  header.writeUInt32BE(encrypted.length + (version === "3.4" ? 36 : 8), 12);
  const body = Buffer.concat([header, encrypted]);
  const trailer = Buffer.alloc(version === "3.4" ? 36 : 8);
  if (version === "3.4") {
    createHmac("sha256", key).update(body).digest().copy(trailer);
  } else {
    trailer.writeUInt32BE(crc32(body));
  }
  trailer.writeUInt32BE(0xaa55, trailer.length - 4);
  return Buffer.concat([body, trailer]);
}

export function decodeFrame(
  packet: Buffer,
  version: Version,
  key: Buffer,
): Frame {
  if (version === "3.5") {
    if (
      packet.length < 54 ||
      packet.readUInt32BE(0) !== 0x6699 ||
      packet.length !== 22 + packet.readUInt32BE(14) ||
      packet.readUInt32BE(packet.length - 4) !== 0x9966
    ) {
      throw new Error("invalid 3.5 frame");
    }
    const decipher = createDecipheriv(
      "aes-128-gcm",
      key,
      packet.subarray(18, 30),
    );
    decipher.setAAD(packet.subarray(4, 18));
    decipher.setAuthTag(packet.subarray(-20, -4));
    const data = Buffer.concat([
      decipher.update(packet.subarray(30, -20)),
      decipher.final(),
    ]);
    if (data.length < 4) {
      throw new Error("frame too short for a return code");
    }
    const retcode = data.readUInt32BE(0);
    if (retcode !== 0) {
      throw new Error(tuyaError(retcode, data.subarray(4)));
    }
    return {
      sequence: packet.readUInt32BE(6),
      command: packet.readUInt32BE(10),
      payload: data.subarray(4),
    };
  }

  const tail = version === "3.4" ? 36 : 8;
  if (
    packet.length < 20 + tail ||
    packet.readUInt32BE(0) !== 0x55aa ||
    packet.length !== 16 + packet.readUInt32BE(12) ||
    packet.readUInt32BE(packet.length - 4) !== 0xaa55
  ) {
    throw new Error("invalid 55AA frame");
  }
  const body = packet.subarray(0, -tail);
  if (version === "3.4") {
    const expected = createHmac("sha256", key).update(body).digest();
    if (!timingSafeEqual(expected, packet.subarray(-tail, -4))) {
      throw new Error("frame HMAC mismatch");
    }
  } else if (crc32(body) !== packet.readUInt32BE(packet.length - tail)) {
    throw new Error("frame CRC mismatch");
  }
  const retcode = packet.readUInt32BE(16);
  if (retcode !== 0) {
    throw new Error(tuyaError(retcode, packet.subarray(20, -tail)));
  }
  let payload = packet.subarray(20, -tail);
  if (payload.length > 0) {
    if (version === "3.4") {
      payload = decryptEcb(payload, key);
    } else if (version === "3.3") {
      if (payload.subarray(0, 3).toString() === "3.3") {
        payload = payload.subarray(15);
      }
      payload = decryptEcb(payload, key);
    } else if (payload.subarray(0, 3).toString() === "3.1") {
      payload = decryptEcb(
        Buffer.from(payload.subarray(19).toString(), "base64"),
        key,
      );
    }
  }
  return {
    sequence: packet.readUInt32BE(4),
    command: packet.readUInt32BE(8),
    payload,
  };
}

/**
 * Explains a refused frame.
 *
 * A device often gives a readable reason, such as "data format error". On the
 * older versions the body may still be encrypted, and ciphertext can hold a
 * few printable bytes by chance, so a reason is quoted only when every byte
 * of it is printable.
 */
function tuyaError(retcode: number, body: Buffer): string {
  const reason = body.toString("latin1").replace(/\0+$/, "");
  const readable = reason.length > 0 && /^[\x20-\x7e]+$/.test(reason);
  return readable
    ? `Tuya refused the frame: ${reason.trim()}`
    : `Tuya return code ${retcode}`;
}

/** Narrows a decoded payload, which arrives as unknown JSON. */
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

export class LocalConnection {
  #socket: Socket;
  #buffer = Buffer.alloc(0);
  #frames: Buffer[] = [];
  #pending?: { resolve: (frame: Buffer) => void; reject: (error: Error) => void };
  #error?: Error;
  #sequence = 1;
  #key: Buffer;

  constructor(
    readonly host: string,
    readonly version: Version,
    private readonly id: string,
    key: Buffer,
    private readonly timeoutMs = 2500,
    port = 6668,
  ) {
    this.#key = key;
    this.#socket = createConnection({ host, port });
    this.#socket.setNoDelay(true);
    this.#socket.on("error", (error) => this.#fail(error));
    this.#socket.on("close", () =>
      this.#fail(new Error("TCP connection closed")),
    );
    this.#socket.on("data", (chunk) => {
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
      try {
        while (this.#buffer.length >= 18) {
          const prefix = this.#buffer.readUInt32BE(0);
          if (prefix !== 0x55aa && prefix !== 0x6699) {
            throw new Error("unexpected TCP frame prefix");
          }
          const length =
            prefix === 0x6699
              ? 22 + this.#buffer.readUInt32BE(14)
              : 16 + this.#buffer.readUInt32BE(12);
          if (length < 24 || length > 65536) {
            throw new Error(`invalid TCP frame length ${length}`);
          }
          if (this.#buffer.length < length) {
            break;
          }
          const frame = this.#buffer.subarray(0, length);
          this.#buffer = this.#buffer.subarray(length);
          if (this.#pending) {
            const pending = this.#pending;
            this.#pending = undefined;
            pending.resolve(frame);
          } else {
            this.#frames.push(frame);
          }
        }
      } catch (error) {
        this.#fail(error instanceof Error ? error : new Error(String(error)));
        this.#socket.destroy();
      }
    });
  }

  #fail(error: Error): void {
    this.#error ??= error;
    this.#pending?.reject(error);
    this.#pending = undefined;
  }

  async #next(deadline: number): Promise<Frame> {
    const next = this.#frames.shift();
    if (next) {
      return decodeFrame(next, this.version, this.#key);
    }
    if (this.#error) {
      throw this.#error;
    }
    const frame = await new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.#pending = undefined;
          reject(new Error(`no answer from ${this.host} (${this.version})`));
          this.#socket.destroy();
        },
        Math.max(0, deadline - performance.now()),
      );
      this.#pending = {
        resolve: (frame) => {
          clearTimeout(timer);
          resolve(frame);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
    });
    return decodeFrame(frame, this.version, this.#key);
  }

  /**
   * Every command except a plain read carries a 15 byte version header: the
   * version string then twelve zero bytes. Without it a device answers
   * "data format error" and does nothing.
   */
  #send(command: number, payload: Buffer): void {
    if (this.#error) {
      throw this.#error;
    }
    const body = BARE_COMMANDS.has(command)
      ? payload
      : Buffer.concat([Buffer.from(this.version), Buffer.alloc(12), payload]);
    this.#socket.write(
      encodeFrame(this.#sequence++, command, body, this.version, this.#key),
    );
  }

  /** Proves the key on 3.4 and 3.5, and derives the session key. */
  async negotiate(): Promise<void> {
    if (this.version !== "3.4" && this.version !== "3.5") {
      return;
    }
    const nonce = randomBytes(16);
    this.#send(SESSION_START, nonce);
    const reply = await this.#next(performance.now() + this.timeoutMs);
    if (reply.command !== 0x04 || reply.payload.length !== 48) {
      throw new Error("unexpected session negotiation response");
    }
    const remote = reply.payload.subarray(0, 16);
    const expected = createHmac("sha256", this.#key).update(nonce).digest();
    if (!timingSafeEqual(expected, reply.payload.subarray(16))) {
      throw new Error("session nonce HMAC mismatch");
    }
    this.#send(
      SESSION_FINISH,
      createHmac("sha256", this.#key).update(remote).digest(),
    );
    const combined = Buffer.from(nonce.map((byte, index) => byte ^ remote[index]!));
    if (this.version === "3.4") {
      this.#key = encryptEcb(combined, this.#key, false);
    } else {
      const cipher = createCipheriv(
        "aes-128-gcm",
        this.#key,
        nonce.subarray(0, 12),
      );
      this.#key = Buffer.concat([cipher.update(combined), cipher.final()]);
    }
  }

  /** Reads every data point the device reports, keyed by DP number. */
  async query(): Promise<Record<string, unknown>> {
    const modern = this.version === "3.4" || this.version === "3.5";
    const command = modern ? QUERY_NEW : QUERY;
    const payload = modern
      ? {}
      : {
          gwId: this.id,
          devId: this.id,
          uid: this.id,
          t: String(Math.floor(Date.now() / 1000)),
        };
    const deadline = performance.now() + this.timeoutMs;
    this.#send(command, Buffer.from(JSON.stringify(payload)));
    while (performance.now() < deadline) {
      const frame = await this.#next(deadline);
      // An unsolicited STATUS push is not the reply to this query.
      if (frame.command !== command || frame.payload.length === 0) {
        continue;
      }
      return this.#dps(frame.payload);
    }
    throw new Error("no data points before the deadline");
  }

  /**
   * Writes data points, keyed by DP number.
   *
   * It resolves only once the device acknowledges. A 3.4 device answers with
   * an empty frame, a 3.5 device with the new state, so neither body is read.
   */
  async control(dps: Record<string, unknown>): Promise<void> {
    const modern = this.version === "3.4" || this.version === "3.5";
    const command = modern ? CONTROL_NEW : CONTROL;
    const t = Math.floor(Date.now() / 1000);
    const payload = modern
      ? { protocol: 5, t, data: { dps } }
      : { devId: this.id, uid: this.id, t: String(t), dps };
    const deadline = performance.now() + this.timeoutMs;
    this.#send(command, Buffer.from(JSON.stringify(payload)));
    while (performance.now() < deadline) {
      const frame = await this.#next(deadline);
      if (frame.command === command || frame.command === STATUS) {
        return;
      }
    }
    throw new Error("no acknowledgement before the deadline");
  }

  #dps(payload: Buffer): Record<string, unknown> {
    let body = payload;
    if (body.subarray(0, 3).toString() === this.version) {
      body = body.subarray(15);
    }
    const decoded = asRecord(JSON.parse(body.toString()));
    const dps = decoded.dps ?? (decoded.data && asRecord(decoded.data).dps);
    if (!dps) {
      throw new Error("device answered without data points");
    }
    return asRecord(dps);
  }

  async close(): Promise<void> {
    if (this.#socket.closed) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.#socket.once("close", () => resolve());
      this.#socket.destroy();
    });
  }
}
