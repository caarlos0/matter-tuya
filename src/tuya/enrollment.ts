import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { TuyaApi, TuyaProperty } from "./api.js";

/**
 * What the bridge needs to talk to one device without the cloud.
 *
 * The key and the data point map cannot be worked out from the device, so
 * the cloud is asked once and the answer is kept. None of it changes while a
 * device stays paired.
 */
export type Enrolled = {
  id: string;
  name: string;
  productName: string;
  /** The 16 byte local key. It changes only when the device is re-paired. */
  key: string;
  /** The thing model, which names each data point and gives its unit. */
  properties: TuyaProperty[];
};

/** The stored file carries a version so an old one can be replaced, not trusted. */
const FORMAT = 1;

/** Maps a data point number to its property code, e.g. 1 to `switch_1`. */
export function codesOf(device: Enrolled): Map<number, string> {
  return new Map(
    device.properties.flatMap(({ abilityId, code }) =>
      abilityId === undefined ? [] : [[abilityId, code] as [number, string]],
    ),
  );
}

export function encode(devices: Enrolled[]): string {
  return `${JSON.stringify({ format: FORMAT, devices }, null, 2)}\n`;
}

/**
 * Reads a stored enrolment, or nothing when it is absent or unusable.
 *
 * A file written by an older version, or by hand, must not stop the bridge.
 * Asking the cloud again costs a few calls and always produces a good one.
 */
export function decode(raw: string | undefined): Enrolled[] | undefined {
  if (!raw) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  const { format, devices } = (parsed ?? {}) as {
    format?: number;
    devices?: Enrolled[];
  };
  if (format !== FORMAT || !Array.isArray(devices) || devices.length === 0) {
    return undefined;
  }

  for (const device of devices) {
    if (
      !device?.id ||
      typeof device.key !== "string" ||
      Buffer.byteLength(device.key) !== 16 ||
      !Array.isArray(device.properties) ||
      device.properties.length === 0
    ) {
      return undefined;
    }
  }

  return devices;
}

/** Asks the cloud for every device and for what it takes to reach it locally. */
export async function fromCloud(api: TuyaApi): Promise<Enrolled[]> {
  const devices: Enrolled[] = [];

  for (const device of await api.devices()) {
    if (!device.local_key || Buffer.byteLength(device.local_key) !== 16) {
      console.warn(`skipping ${device.name}: it has no 16 byte local key`);
      continue;
    }
    const properties = await api.properties(device.id);
    if (properties.every(({ abilityId }) => abilityId === undefined)) {
      console.warn(`skipping ${device.name}: its thing model has no data points`);
      continue;
    }
    devices.push({
      id: device.id,
      name: device.name,
      productName: device.product_name ?? device.category,
      key: device.local_key,
      properties,
    });
  }

  if (devices.length === 0) {
    throw new Error("the cloud lists no device that can be reached locally");
  }
  return devices;
}

/**
 * Loads the enrolment, asking the cloud only when there is nothing to load.
 *
 * `connect` is called lazily, so a bridge with a stored enrolment needs no
 * cloud credentials at all.
 */
export async function load(
  file: string,
  connect: () => Promise<TuyaApi>,
): Promise<Enrolled[]> {
  const stored = decode(
    await readFile(file, "utf8").catch(() => undefined),
  );
  if (stored) {
    return stored;
  }

  console.log("enrolling devices from the Tuya cloud, once");
  const devices = await fromCloud(await connect());
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, encode(devices));
  console.log(`enrolled ${devices.length} devices into ${file}`);
  return devices;
}
