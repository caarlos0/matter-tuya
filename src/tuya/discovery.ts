import { createConnection } from "node:net";

import { LocalConnection, VERSIONS, type Version } from "./protocol.js";

export const TUYA_PORT = 6668;

/** Where a device answered, and the protocol version it speaks. */
export type Address = { host: string; version: Version };

/** What discovery needs to recognise one device. */
export type Identity = { id: string; key: string };

/**
 * Expands a CIDR block into its host addresses.
 *
 * Broadcast discovery is not used: it never crosses a VLAN, and IoT devices
 * usually sit on one of their own. A connection to the Tuya port works across
 * a router, so the subnet is scanned instead.
 */
export function hostsOf(cidr: string): string[] {
  const match = /^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/.exec(cidr.trim());
  if (!match) {
    throw new Error(`${cidr} is not a CIDR block such as 192.168.1.0/24`);
  }

  const octets = match.slice(1, 5).map(Number);
  const bits = Number(match[5]);
  if (octets.some((octet) => octet > 255) || bits < 8 || bits > 32) {
    throw new Error(`${cidr} is not a usable CIDR block`);
  }
  if (bits < 22) {
    throw new Error(`${cidr} covers too many addresses to scan`);
  }

  const base =
    ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>>
    0;
  const size = 2 ** (32 - bits);
  const network = base & (size === 2 ** 32 ? 0 : ~(size - 1));

  const hosts: string[] = [];
  // A /32 is one address; anything wider omits the network and broadcast ones.
  const first = size <= 2 ? 0 : 1;
  const last = size <= 2 ? size : size - 1;
  for (let offset = first; offset < last; offset++) {
    const address = (network + offset) >>> 0;
    hosts.push(
      [address >>> 24, (address >>> 16) & 255, (address >>> 8) & 255, address & 255].join(
        ".",
      ),
    );
  }
  return hosts;
}

function reachable(host: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port: TUYA_PORT });
    const finish = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

/** Lists the addresses in the subnet that accept a Tuya connection. */
export async function scan(
  cidr: string,
  { timeoutMs = 1500, concurrency = 64 } = {},
): Promise<string[]> {
  const hosts = hostsOf(cidr);
  const open: string[] = [];
  for (let index = 0; index < hosts.length; index += concurrency) {
    const batch = hosts.slice(index, index + concurrency);
    const results = await Promise.all(
      batch.map(async (host) => ((await reachable(host, timeoutMs)) ? host : "")),
    );
    open.push(...results.filter(Boolean));
  }
  return open;
}

/**
 * Asks whether one device answers at one address, in one version.
 *
 * Only the device holding the key completes the handshake, so a wrong guess
 * is refused rather than believed. A refusal is silent, though: a frame
 * sealed with the wrong key is dropped, not answered, so every wrong guess
 * costs the timeout. That is why the timeout here is short and why the
 * guessing is done in parallel.
 */
export async function identify(
  host: string,
  device: Identity,
  version: Version,
  timeoutMs = 900,
): Promise<boolean> {
  const connection = new LocalConnection(
    host,
    version,
    device.id,
    Buffer.from(device.key),
    timeoutMs,
  );
  try {
    await connection.negotiate();
    await connection.query();
    return true;
  } catch {
    return false;
  } finally {
    await connection.close();
  }
}

/**
 * Finds every known device on the subnet.
 *
 * The address a device used last is tried first, because it is nearly always
 * the one it still uses. Anything still missing is searched for one version
 * at a time across every address at once: a subnet almost always speaks a
 * single version, so the first pass usually places everything, and the
 * addresses are searched in parallel because each wrong guess costs a
 * timeout rather than a refusal.
 *
 * Only one exchange at a time is made with any one address, because these
 * devices accept only one connection.
 */
export async function locate(
  cidr: string,
  devices: Identity[],
  known: Map<string, Address> = new Map(),
  options: { timeoutMs?: number; concurrency?: number } = {},
): Promise<Map<string, Address>> {
  const found = new Map<string, Address>();

  await Promise.all(
    devices.map(async (device) => {
      const address = known.get(device.id);
      if (address && (await identify(address.host, device, address.version))) {
        found.set(device.id, address);
      }
    }),
  );

  if (found.size === devices.length) {
    return found;
  }

  const claimed = new Set([...found.values()].map(({ host }) => host));
  const hosts = (await scan(cidr, options)).filter(
    (host) => !claimed.has(host),
  );

  // A version already proven on this subnet is the one to try first.
  const seen = [...known.values()].map(({ version }) => version);
  const order = [...new Set([...seen, ...VERSIONS])];

  for (const version of order) {
    if (found.size === devices.length) {
      break;
    }
    await Promise.all(
      hosts
        .filter((host) => !claimed.has(host))
        .map(async (host) => {
          for (const device of devices) {
            if (found.has(device.id) || claimed.has(host)) {
              continue;
            }
            if (await identify(host, device, version)) {
              found.set(device.id, { host, version });
              claimed.add(host);
              return;
            }
          }
        }),
    );
  }

  return found;
}
