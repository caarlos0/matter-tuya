import { Endpoint, ServerNode, VendorId } from "@matter/main";
import { BasicInformationServer } from "@matter/main/behaviors/basic-information";
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

  /** Exposes a device the user has just chosen, and tells the controllers. */
  async addDevice(
    info: DeviceInfo,
    setSwitch?: (on: boolean) => Promise<void>,
  ): Promise<void> {
    await this.#add(info, setSwitch, true);
  }

  /**
   * Rebuilds a device that was already exposed before a restart.
   *
   * Nothing has changed for a controller, so nothing is announced: the bridge
   * carries exactly the endpoints it carried before.
   */
  async restoreDevice(
    info: DeviceInfo,
    setSwitch?: (on: boolean) => Promise<void>,
  ): Promise<void> {
    await this.#add(info, setSwitch, false);
  }

  async removeDevice(deviceId: string): Promise<void> {
    const device = this.#devices.get(deviceId);
    if (device) {
      this.#devices.delete(deviceId);
      await this.#reconfigure(() => device.root.delete());
    }
  }

  async #add(
    info: DeviceInfo,
    setSwitch: ((on: boolean) => Promise<void>) | undefined,
    announce: boolean,
  ): Promise<void> {
    const aggregator = this.#aggregator;
    if (!aggregator) {
      throw new Error("bridge not started");
    }
    const device = new DeviceEndpoint(info, setSwitch);
    const add = async () => {
      await aggregator.add(device.root);
    };
    await (announce ? this.#reconfigure(add) : add());
    this.#devices.set(info.id, device);
  }

  /**
   * Changes which endpoints the bridge carries, and says so.
   *
   * A controller learns that a bridge changed from its configuration version.
   * Adding or removing an endpoint without raising it leaves the new device
   * invisible until the controller happens to look again, which is why a
   * device chosen on the page never appeared in Apple Home.
   */
  async #reconfigure(change: () => Promise<void>): Promise<void> {
    const node = this.#node;
    if (!node) {
      throw new Error("bridge not started");
    }
    await node.act((agent) =>
      agent.get(BasicInformationServer).increaseConfigurationVersion(change),
    );
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
