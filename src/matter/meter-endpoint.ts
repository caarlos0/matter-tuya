import { Endpoint } from "@matter/main";
import { BridgedDeviceBasicInformationServer } from "@matter/main/behaviors/bridged-device-basic-information";
import { ElectricalEnergyMeasurementServer } from "@matter/main/behaviors/electrical-energy-measurement";
import { ElectricalPowerMeasurementServer } from "@matter/main/behaviors/electrical-power-measurement";
import { PowerTopologyServer } from "@matter/main/behaviors/power-topology";
import { ElectricalPowerMeasurement } from "@matter/main/clusters";
import { ElectricalSensorEndpoint } from "@matter/main/endpoints/electrical-sensor";
import { MeasurementType } from "@matter/main/types";

import type { Measurement, Quantity, Readings } from "../tuya/meters.js";

const MEASUREMENT_TYPES: Record<Quantity, MeasurementType> = {
  power: MeasurementType.ActivePower,
  voltage: MeasurementType.Voltage,
  current: MeasurementType.ActiveCurrent,
  energy: MeasurementType.ElectricalEnergy,
};

/** Matter allows at most 32 characters per string attribute. */
const LABEL_LENGTH = 32;

const MeterEndpoint = ElectricalSensorEndpoint.with(
  BridgedDeviceBasicInformationServer,
  PowerTopologyServer.with("NodeTopology"),
  ElectricalPowerMeasurementServer.with("AlternatingCurrent"),
  ElectricalEnergyMeasurementServer.with("ImportedEnergy", "CumulativeEnergy"),
);

export type MeterInfo = {
  id: string;
  name: string;
  vendorName: string;
  productName: string;
  reachable: boolean;
  measurements: Measurement[];
};

/** A Tuya electricity meter exposed as a bridged Matter electrical sensor. */
export class MeterEndpointHandle {
  readonly endpoint: Endpoint<typeof MeterEndpoint>;

  constructor(info: MeterInfo) {
    const powerAccuracy = info.measurements
      .filter(({ quantity }) => quantity !== "energy")
      .map(({ quantity }) => accuracyOf(quantity));

    this.endpoint = new Endpoint(MeterEndpoint, {
      id: endpointId(info.id),
      bridgedDeviceBasicInformation: {
        nodeLabel: info.name.slice(0, LABEL_LENGTH),
        vendorName: info.vendorName.slice(0, LABEL_LENGTH),
        productName: info.productName.slice(0, LABEL_LENGTH),
        serialNumber: info.id.slice(0, LABEL_LENGTH),
        reachable: info.reachable,
      },
      electricalPowerMeasurement: {
        powerMode: ElectricalPowerMeasurement.PowerMode.Ac,
        numberOfMeasurementTypes: powerAccuracy.length,
        accuracy: powerAccuracy,
        activePower: null,
        voltage: null,
        activeCurrent: null,
      },
      electricalEnergyMeasurement: {
        accuracy: accuracyOf("energy"),
        cumulativeEnergyImported: null,
      },
    });
  }

  async update(reachable: boolean, readings: Readings): Promise<void> {
    await this.endpoint.set({
      bridgedDeviceBasicInformation: { reachable },
      electricalPowerMeasurement: {
        activePower: readings.power ?? null,
        voltage: readings.voltage ?? null,
        activeCurrent: readings.current ?? null,
      },
      electricalEnergyMeasurement: {
        cumulativeEnergyImported:
          readings.energy === undefined ? null : { energy: readings.energy },
      },
    });
  }
}

/**
 * Matter requires an accuracy entry per measurement type. Tuya publishes no
 * accuracy, so every range is declared as exact.
 */
function accuracyOf(quantity: Quantity) {
  return {
    measurementType: MEASUREMENT_TYPES[quantity],
    measured: true,
    minMeasuredValue: 0,
    maxMeasuredValue: Number.MAX_SAFE_INTEGER,
    accuracyRanges: [
      { rangeMin: 0, rangeMax: Number.MAX_SAFE_INTEGER, fixedMax: 1 },
    ],
  };
}

/** Matter endpoint ids allow only letters, digits, `_` and `-`. */
function endpointId(deviceId: string): string {
  return `tuya-${deviceId.replace(/[^A-Za-z0-9_-]/g, "")}`;
}
