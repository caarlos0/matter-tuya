import type { Bridge } from "./matter/bridge.js";
import type { TuyaApi, TuyaDevice } from "./tuya/api.js";
import {
  capabilitiesOf,
  readMeasurements,
  type Capabilities,
  type Quantity,
  type Readings,
} from "./tuya/capabilities.js";
import { loadEnabled, saveEnabled } from "./state.js";

export type DeviceView = {
  id: string;
  name: string;
  productName: string;
  online: boolean;
  /** Empty when the device reports no electricity. */
  quantities: Quantity[];
  switchable: boolean;
  enabled: boolean;
  readings: Readings;
  on?: boolean;
};

type Entry = {
  device: TuyaDevice;
  capabilities: Capabilities;
  readings: Readings;
  on?: boolean;
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
        capabilities:
          known?.capabilities ??
          capabilitiesOf(await this.api.properties(device.id)),
        readings: known?.readings ?? {},
        on: known?.on,
      });
    }

    this.#entries = entries;
    await this.#dropMissing();
  }

  list(): DeviceView[] {
    return [...this.#entries.values()]
      .map(({ device, capabilities, readings, on }) => ({
        id: device.id,
        name: device.name,
        productName: productName(device),
        online: device.online,
        quantities: capabilities.measurements.map(({ quantity }) => quantity),
        switchable: capabilities.switchCode !== undefined,
        enabled: this.#enabled.has(device.id),
        readings,
        on,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const entry = this.#entries.get(id);
    if (!entry) {
      throw new Error(`unknown device ${id}`);
    }
    if (enabled && !exposable(entry)) {
      throw new Error(
        `device ${entry.device.name} has no switch and no electricity metering`,
      );
    }
    if (enabled === this.#enabled.has(id)) {
      return;
    }

    if (enabled) {
      this.#enabled.add(id);
      await this.#addToBridge(id);
      // Publish the real state at once; waiting for the next poll would show a
      // switched-on device as off.
      await this.#read(id);
    } else {
      this.#enabled.delete(id);
      await this.bridge.removeDevice(id);
    }

    await saveEnabled(this.stateFile, this.#enabled);
  }

  /** Reads the enabled devices and pushes the values into Matter. */
  async poll(): Promise<void> {
    for (const id of this.#enabled) {
      await this.#read(id);
    }
  }

  async #read(id: string): Promise<void> {
    const entry = this.#entries.get(id);
    if (!entry) {
      return;
    }
    try {
      const values = await this.api.values(id);
      const { measurements, switchCode } = entry.capabilities;
      entry.readings = readMeasurements(measurements, values);
      entry.on = switchCode
        ? values.find(({ code }) => code === switchCode)?.value === true
        : undefined;
      await this.bridge.updateDevice(id, {
        reachable: true,
        readings: entry.readings,
        on: entry.on,
      });
    } catch (error) {
      console.error(`failed to read ${entry.device.name}:`, error);
      await this.bridge.updateDevice(id, { reachable: false, readings: {} });
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
      await this.bridge.removeDevice(id);
    }
    await saveEnabled(this.stateFile, this.#enabled);
  }

  async #addToBridge(id: string): Promise<void> {
    const entry = this.#entries.get(id);
    if (!entry || !exposable(entry)) {
      return;
    }
    const { measurements, switchCode } = entry.capabilities;
    await this.bridge.addDevice(
      {
        id,
        name: entry.device.name,
        productName: productName(entry.device),
        reachable: entry.device.online,
        measurements,
      },
      switchCode === undefined
        ? undefined
        : async (on) => {
            await this.api.setProperty(id, switchCode, on);
            entry.on = on;
          },
    );
  }
}

function productName(device: TuyaDevice): string {
  return device.product_name ?? device.category;
}

function exposable({ capabilities }: Entry): boolean {
  return (
    capabilities.measurements.length > 0 || capabilities.switchCode !== undefined
  );
}
