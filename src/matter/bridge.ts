import { Endpoint, ServerNode, VendorId } from "@matter/main";
import { AggregatorEndpoint } from "@matter/main/endpoints/aggregator";

import type { Config } from "../config.js";
import type { Readings } from "../tuya/meters.js";
import { MeterEndpointHandle, type MeterInfo } from "./meter-endpoint.js";

// Test vendor id reserved by the CSA for development.
const VENDOR_ID = VendorId(0xfff1);
const PRODUCT_ID = 0x8000;

export class Bridge {
  #node?: ServerNode;
  #aggregator?: Endpoint<typeof AggregatorEndpoint>;
  readonly #meters = new Map<string, MeterEndpointHandle>();

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

  async addMeter(info: MeterInfo): Promise<void> {
    const aggregator = this.#aggregator;
    if (!aggregator) {
      throw new Error("bridge not started");
    }
    const meter = new MeterEndpointHandle(info);
    await aggregator.add(meter.endpoint);
    this.#meters.set(info.id, meter);
  }

  async removeMeter(deviceId: string): Promise<void> {
    const meter = this.#meters.get(deviceId);
    if (meter) {
      this.#meters.delete(deviceId);
      await meter.endpoint.delete();
    }
  }

  async updateMeter(
    deviceId: string,
    reachable: boolean,
    readings: Readings,
  ): Promise<void> {
    await this.#meters.get(deviceId)?.update(reachable, readings);
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
