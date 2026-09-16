import type { Bridge } from "./matter/bridge.js";
import type { TuyaApi, TuyaDevice } from "./tuya/api.js";
import {
  measurementsOf,
  readMeasurements,
  type Measurement,
  type Quantity,
  type Readings,
} from "./tuya/meters.js";
import { loadEnabled, saveEnabled } from "./state.js";

export type DeviceView = {
  id: string;
  name: string;
  productName: string;
  online: boolean;
  /** Empty when the device reports no electricity, so it cannot be exposed. */
  quantities: Quantity[];
  enabled: boolean;
  readings: Readings;
};

type Entry = {
  device: TuyaDevice;
  measurements: Measurement[];
  readings: Readings;
};

/** Tracks the Tuya devices and which of them are bridged to Matter. */
export class Devices {
  #entries = new Map<string, Entry>();
  #enabled = new Set<string>();

  constructor(
    private readonly api: TuyaApi,
    private readonly bridge: Bridge,
    private readonly stateFile: string,
  ) {}

  /** Loads the device list and bridges the devices enabled in an earlier run. */
  async load(): Promise<void> {
    await this.refresh();
    this.#enabled = await loadEnabled(this.stateFile);
    for (const id of this.#enabled) {
      await this.#addToBridge(id);
    }
  }

  /** Reloads the device list and the thing model of every new device. */
  async refresh(): Promise<void> {
    const entries = new Map<string, Entry>();

    for (const device of await this.api.devices()) {
      const known = this.#entries.get(device.id);
      entries.set(device.id, {
        device,
        measurements:
          known?.measurements ??
          measurementsOf(await this.api.properties(device.id)),
        readings: known?.readings ?? {},
      });
    }

    this.#entries = entries;
    await this.#dropMissing();
  }

  list(): DeviceView[] {
    return [...this.#entries.values()]
      .map(({ device, measurements, readings }) => ({
        id: device.id,
        name: device.name,
        productName: productName(device),
        online: device.online,
        quantities: measurements.map(({ quantity }) => quantity),
        enabled: this.#enabled.has(device.id),
        readings,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const entry = this.#entries.get(id);
    if (!entry) {
      throw new Error(`unknown device ${id}`);
    }
    if (enabled && entry.measurements.length === 0) {
      throw new Error(`device ${entry.device.name} reports no electricity`);
    }
    if (enabled === this.#enabled.has(id)) {
      return;
    }

    if (enabled) {
      this.#enabled.add(id);
      await this.#addToBridge(id);
    } else {
      this.#enabled.delete(id);
      await this.bridge.removeMeter(id);
    }

    await saveEnabled(this.stateFile, this.#enabled);
  }

  /** Reads the enabled devices and pushes the values into Matter. */
  async poll(): Promise<void> {
    for (const id of this.#enabled) {
      const entry = this.#entries.get(id);
      if (!entry) {
        continue;
      }
      try {
        entry.readings = readMeasurements(
          entry.measurements,
          await this.api.values(id),
        );
        await this.bridge.updateMeter(id, true, entry.readings);
      } catch (error) {
        console.error(`failed to read ${entry.device.name}:`, error);
        await this.bridge.updateMeter(id, false, {});
      }
    }
  }

  /** Unbridges devices that disappeared from the Tuya account. */
  async #dropMissing(): Promise<void> {
    const missing = [...this.#enabled].filter((id) => !this.#entries.has(id));
    if (missing.length === 0) {
      return;
    }
    for (const id of missing) {
      this.#enabled.delete(id);
      await this.bridge.removeMeter(id);
    }
    await saveEnabled(this.stateFile, this.#enabled);
  }

  async #addToBridge(id: string): Promise<void> {
    const entry = this.#entries.get(id);
    if (!entry || entry.measurements.length === 0) {
      return;
    }
    await this.bridge.addMeter({
      id,
      name: entry.device.name,
      productName: productName(entry.device),
      reachable: entry.device.online,
      measurements: entry.measurements,
    });
  }
}

function productName(device: TuyaDevice): string {
  return device.product_name ?? device.category;
}
