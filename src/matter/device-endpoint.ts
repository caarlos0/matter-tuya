import { Endpoint } from "@matter/main";
import { BridgedDeviceBasicInformationServer } from "@matter/main/behaviors/bridged-device-basic-information";
import { ElectricalEnergyMeasurementServer } from "@matter/main/behaviors/electrical-energy-measurement";
import { ElectricalPowerMeasurementServer } from "@matter/main/behaviors/electrical-power-measurement";
import { OnOffServer } from "@matter/main/behaviors/on-off";
import { PowerTopologyServer } from "@matter/main/behaviors/power-topology";
import { ElectricalPowerMeasurement } from "@matter/main/clusters";
import { OnOffPlugInUnitDevice } from "@matter/main/devices/on-off-plug-in-unit";
import { ElectricalSensorEndpoint } from "@matter/main/endpoints/electrical-sensor";
import { MeasurementType } from "@matter/main/types";

import type { Measurement, Quantity, Readings } from "../tuya/capabilities.js";

const MEASUREMENT_TYPES: Record<Quantity, MeasurementType> = {
  power: MeasurementType.ActivePower,
  voltage: MeasurementType.Voltage,
  current: MeasurementType.ActiveCurrent,
  energy: MeasurementType.ElectricalEnergy,
};

/** Matter allows at most 32 characters per string attribute. */
const LABEL_LENGTH = 32;

const VENDOR_NAME = "Tuya";

const SensorEndpoint = ElectricalSensorEndpoint.with(
  PowerTopologyServer.with("NodeTopology"),
  ElectricalPowerMeasurementServer.with("AlternatingCurrent"),
  ElectricalEnergyMeasurementServer.with("ImportedEnergy", "CumulativeEnergy"),
);

const BridgedSensorEndpoint = SensorEndpoint.with(
  BridgedDeviceBasicInformationServer,
);

export type DeviceInfo = {
  id: string;
  name: string;
  productName: string;
  reachable: boolean;
  measurements: Measurement[];
};

export type DeviceState = {
  reachable: boolean;
  readings: Readings;
  on?: boolean;
};

type Shape =
  | {
      plug: Endpoint<ReturnType<typeof plugType>>;
      sensor?: Endpoint<typeof SensorEndpoint>;
    }
  | { sensor: Endpoint<typeof BridgedSensorEndpoint> };

/**
 * A Tuya device exposed as a bridged Matter endpoint.
 *
 * A device with a switch becomes an on/off plug-in unit, with its meter as a
 * composed electrical sensor endpoint. A device that only meters becomes a
 * bridged electrical sensor.
 */
export class DeviceEndpoint {
  readonly #shape: Shape;

  constructor(info: DeviceInfo, setSwitch?: (on: boolean) => Promise<void>) {
    const bridgedDeviceBasicInformation = {
      nodeLabel: info.name.slice(0, LABEL_LENGTH),
      vendorName: VENDOR_NAME,
      productName: info.productName.slice(0, LABEL_LENGTH),
      serialNumber: info.id.slice(0, LABEL_LENGTH),
      reachable: info.reachable,
    };
    const id = endpointId(info.id);

    if (!setSwitch) {
      this.#shape = {
        sensor: new Endpoint(BridgedSensorEndpoint, {
          id,
          bridgedDeviceBasicInformation,
          ...sensorDefaults(info.measurements),
        }),
      };
      return;
    }

    const sensor =
      info.measurements.length > 0
        ? new Endpoint(SensorEndpoint, {
            id: "meter",
            ...sensorDefaults(info.measurements),
          })
        : undefined;

    this.#shape = {
      plug: new Endpoint(plugType(setSwitch), {
        id,
        bridgedDeviceBasicInformation,
        parts: sensor ? [sensor] : [],
      }),
      sensor,
    };
  }

  /** The endpoint the aggregator owns. */
  get root(): Endpoint {
    return "plug" in this.#shape ? this.#shape.plug : this.#shape.sensor;
  }

  async update({ reachable, readings, on }: DeviceState): Promise<void> {
    if (!("plug" in this.#shape)) {
      await this.#shape.sensor.set({
        bridgedDeviceBasicInformation: { reachable },
        ...measurements(readings),
      });
      return;
    }

    await this.#shape.plug.set({
      bridgedDeviceBasicInformation: { reachable },
      ...(on === undefined ? {} : { onOff: { onOff: on } }),
    });
    await this.#shape.sensor?.set(measurements(readings));
  }
}

function measurements(readings: Readings) {
  return {
    electricalPowerMeasurement: {
      activePower: readings.power ?? null,
      voltage: readings.voltage ?? null,
      activeCurrent: readings.current ?? null,
    },
    electricalEnergyMeasurement: {
      cumulativeEnergyImported:
        readings.energy === undefined ? null : { energy: readings.energy },
    },
  };
}

/**
 * Builds a plug type that forwards the Matter on/off commands to Tuya. The
 * command fails if Tuya rejects it, so Matter never reports a state the device
 * did not reach.
 */
function plugType(setSwitch: (on: boolean) => Promise<void>) {
  return OnOffPlugInUnitDevice.with(
    BridgedDeviceBasicInformationServer,
    class TuyaOnOffServer extends OnOffServer {
      override async on() {
        await setSwitch(true);
        await super.on();
      }

      override async off() {
        await setSwitch(false);
        await super.off();
      }
    },
  );
}

function sensorDefaults(measurements: Measurement[]) {
  const powerAccuracy = measurements
    .filter(({ quantity }) => quantity !== "energy")
    .map(({ quantity }) => accuracyOf(quantity));

  return {
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
  };
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
