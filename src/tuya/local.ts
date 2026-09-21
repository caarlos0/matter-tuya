import { LocalConnection } from "./protocol.js";
import { codesOf, type Enrolled } from "./enrollment.js";
import { locate, type Address } from "./discovery.js";
import type { TuyaPropertyValue } from "./capabilities.js";

/**
 * Reads and writes Tuya devices on the local network.
 *
 * Every call opens its own connection. Devices close an idle socket, and a
 * heartbeat often enough to stop that would cost more traffic than the poll
 * it protects, so the handshake is paid each time. It costs about 150 ms,
 * which is less than the cloud ever cost.
 */
/** A subnet does not change by the minute, so it is not searched by the minute. */
const SEARCH_INTERVAL_MS = 60_000;

export class TuyaLocal {
  readonly #devices = new Map<string, Enrolled>();
  readonly #codes = new Map<string, Map<number, string>>();
  #addresses = new Map<string, Address>();
  #searchedAt = -Infinity;

  constructor(
    devices: Enrolled[],
    private readonly subnet: string,
    addresses: Map<string, Address> = new Map(),
    private readonly onMove: (addresses: Map<string, Address>) => void = () => {},
  ) {
    this.#addresses = addresses;
    for (const device of devices) {
      this.#devices.set(device.id, device);
      this.#codes.set(device.id, codesOf(device));
    }
  }

  /** Every enrolled device, whether or not it answers. */
  get devices(): Enrolled[] {
    return [...this.#devices.values()];
  }

  /** Where each device answered when the subnet was last searched. */
  get addresses(): Map<string, Address> {
    return new Map(this.#addresses);
  }

  reachable(deviceId: string): boolean {
    return this.#addresses.has(deviceId);
  }

  /**
   * Searches the subnet for every enrolled device.
   *
   * A device that does not answer is simply absent: it is switched off, or
   * off the network. It stays listed, and reports as unreachable.
   *
   * A device that never answers would otherwise make every poll search the
   * whole subnet again, so a search is not repeated too soon unless it was
   * asked for.
   */
  async discover(force = false): Promise<void> {
    if (!force && performance.now() - this.#searchedAt < SEARCH_INTERVAL_MS) {
      return;
    }
    this.#searchedAt = performance.now();
    this.#addresses = await locate(
      this.subnet,
      this.devices.map(({ id, key }) => ({ id, key })),
      this.#addresses,
    );
    this.onMove(this.addresses);
  }

  /** Reads every property the device reports, named as the thing model names it. */
  async values(deviceId: string): Promise<TuyaPropertyValue[]> {
    const codes = this.#codes.get(deviceId);
    if (!codes) {
      throw new Error(`${deviceId} is not enrolled`);
    }
    const dps = await this.#connect(deviceId, (connection) => connection.query());
    return Object.entries(dps).flatMap(([dp, value]) => {
      const code = codes.get(Number(dp));
      return code ? [{ code, value }] : [];
    });
  }

  /** Writes one property, e.g. `switch_1`. */
  async setProperty(
    deviceId: string,
    code: string,
    value: boolean,
  ): Promise<void> {
    const dp = [...(this.#codes.get(deviceId) ?? [])].find(
      ([, name]) => name === code,
    )?.[0];
    if (dp === undefined) {
      throw new Error(`${deviceId} has no data point named ${code}`);
    }
    await this.#connect(deviceId, (connection) =>
      connection.control({ [dp]: value }),
    );
  }

  /**
   * Runs one exchange with a device, searching for it again if it has moved.
   *
   * A new lease, or two devices that swapped addresses, is therefore repaired
   * without help: only the device holding the key completes a handshake.
   */
  async #connect<T>(
    deviceId: string,
    exchange: (connection: LocalConnection) => Promise<T>,
  ): Promise<T> {
    const device = this.#devices.get(deviceId);
    if (!device) {
      throw new Error(`${deviceId} is not enrolled`);
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      const address = this.#addresses.get(deviceId);
      if (address) {
        const connection = new LocalConnection(
          address.host,
          address.version,
          device.id,
          Buffer.from(device.key),
        );
        try {
          await connection.negotiate();
          return await exchange(connection);
        } catch (error) {
          if (attempt > 0) {
            throw error;
          }
          this.#addresses.delete(deviceId);
        } finally {
          await connection.close();
        }
      }
      await this.discover();
    }

    throw new Error(`${device.name} answered nowhere in ${this.subnet}`);
  }
}
