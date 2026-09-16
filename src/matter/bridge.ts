import { Endpoint, ServerNode, VendorId } from "@matter/main";
import { AggregatorEndpoint } from "@matter/main/endpoints/aggregator";

import type { Config } from "../config.js";
import {
  DeviceEndpoint,
  type DeviceInfo,
  type DeviceState,
} from "./device-endpoint.js";

// Test vendor id reserved by the CSA for development.
const VENDOR_ID = VendorId(0xfff1);
const PRODUCT_ID = 0x8000;

export class Bridge {
  #node?: ServerNode;
  #aggregator?: Endpoint<typeof AggregatorEndpoint>;
  readonly #devices = new Map<string, DeviceEndpoint>();

  constructor(private readonly config: Config["matter"]) {}

  async start(): Promise<void> {
    this.#node = await ServerNode.create({
      id: "tuya-matter",
      network: { port: this.config.port },
      commissioning: {
        passcode: this.config.passcode,
        discriminator: this.config.discriminator,
      },
      productDescription: {
        name: "Tuya Bridge",
        deviceType: AggregatorEndpoint.deviceType,
      },
      basicInformation: {
        vendorId: VENDOR_ID,
        vendorName: "tuya-matter",
        productId: PRODUCT_ID,
        productName: "Tuya Bridge",
        nodeLabel: "Tuya Bridge",
      },
    });

    this.#aggregator = new Endpoint(AggregatorEndpoint, { id: "aggregator" });
    await this.#node.add(this.#aggregator);
    await this.#node.start();
  }

  async stop(): Promise<void> {
    await this.#node?.close();
  }

  async addDevice(
    info: DeviceInfo,
    setSwitch?: (on: boolean) => Promise<void>,
  ): Promise<void> {
    const aggregator = this.#aggregator;
    if (!aggregator) {
      throw new Error("bridge not started");
    }
    const device = new DeviceEndpoint(info, setSwitch);
    await aggregator.add(device.root);
    this.#devices.set(info.id, device);
  }

  async removeDevice(deviceId: string): Promise<void> {
    const device = this.#devices.get(deviceId);
    if (device) {
      this.#devices.delete(deviceId);
      await device.root.delete();
    }
  }

  async updateDevice(deviceId: string, state: DeviceState): Promise<void> {
    await this.#devices.get(deviceId)?.update(state);
  }

  /** Commissioning details, or undefined once the bridge is commissioned. */
  get commissioning():
    | { manualPairingCode: string; qrPairingCode: string }
    | undefined {
    const state = this.#node?.state.commissioning;
    if (!state || state.commissioned) {
      return undefined;
    }
    return state.pairingCodes;
  }
}
