import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { Address } from "./tuya/discovery.js";
import { VERSIONS } from "./tuya/protocol.js";

/**
 * Remembers where each device answered.
 *
 * It is only a hint, never a fact: a handshake still has to prove which
 * device is there. Keeping it turns a restart into a handful of exchanges
 * rather than a full search of the subnet.
 */
export async function loadAddresses(
  file: string,
): Promise<Map<string, Address>> {
  const addresses = new Map<string, Address>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return addresses;
  }

  for (const [id, address] of Object.entries(
    (parsed ?? {}) as Record<string, Address>,
  )) {
    if (
      typeof address?.host === "string" &&
      VERSIONS.includes(address.version)
    ) {
      addresses.set(id, { host: address.host, version: address.version });
    }
  }
  return addresses;
}

export async function saveAddresses(
  file: string,
  addresses: Map<string, Address>,
): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    `${JSON.stringify(Object.fromEntries(addresses), null, 2)}\n`,
  );
}
