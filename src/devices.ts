import type { Bridge } from "./matter/bridge.js";
import {
  capabilitiesOf,
  readMeasurements,
  type Capabilities,
  type Quantity,
  type Readings,
} from "./tuya/capabilities.js";
import type { Enrolled } from "./tuya/enrollment.js";
import type { TuyaLocal } from "./tuya/local.js";
import { loadEnabled, saveEnabled } from "./state.js";

export type DeviceView = {
  id: string;
  name: string;
  productName: string;
  /** Whether the device answered on the local network. */
  online: boolean;
  /** Empty when the device reports no electricity. */
  quantities: Quantity[];
  switchable: boolean;
  enabled: boolean;
  readings: Readings;
  on?: boolean;
};

type Entry = {
  device: Enrolled;
  capabilities: Capabilities;
  readings: Readings;
  on?: boolean;
};

/** Tracks the Tuya devices and which of them are bridged to Matter. */
export class Devices {
  readonly #entries = new Map<string, Entry>();
  #enabled = new Set<string>();

  constructor(
    private readonly tuya: TuyaLocal,
    private readonly bridge: Bridge,
    private readonly stateFile: string,
  ) {
    for (const device of tuya.devices) {
      this.#entries.set(device.id, {
        device,
        capabilities: capabilitiesOf(device.properties),
        readings: {},
      });
    }
  }

  /** Searches the subnet, then bridges the devices enabled in an earlier run. */
  async load(): Promise<void> {
    await this.refresh();
    this.#enabled = await loadEnabled(this.stateFile);
    for (const id of this.#enabled) {
      await this.#addToBridge(id);
    }
  }

  /** Searches the subnet again, to find devices that moved or came back. */
  async refresh(): Promise<void> {
    await this.tuya.discover(true);
  }

  list(): DeviceView[] {
    return [...this.#entries.values()]
      .map(({ device, capabilities, readings, on }) => ({
        id: device.id,
        name: device.name,
        productName: device.productName,
        online: this.tuya.reachable(device.id),
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
      const values = await this.tuya.values(id);
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
        productName: entry.device.productName,
        reachable: this.tuya.reachable(id),
        measurements,
      },
      switchCode === undefined
        ? undefined
        : async (on) => {
            await this.tuya.setProperty(id, switchCode, on);
            entry.on = on;
          },
    );
  }
}

function exposable({ capabilities }: Entry): boolean {
  return (
    capabilities.measurements.length > 0 || capabilities.switchCode !== undefined
  );
}
