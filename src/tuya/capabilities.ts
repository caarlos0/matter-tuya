import type { TuyaProperty } from "./api.js";

/** One reported property value, named as the thing model names it. */
export type TuyaPropertyValue = { code: string; value: unknown };

/**
 * Matter reports electricity in milli-units: mW, mV, mA and mWh. Every Tuya
 * property is scaled into one of them.
 */
export type Quantity = "power" | "voltage" | "current" | "energy";

export type Measurement = {
  quantity: Quantity;
  /** Tuya property code, e.g. `cur_power`. */
  code: string;
  /** Multiplier from the raw Tuya value to the Matter milli-unit. */
  factor: number;
};

export type Readings = Partial<Record<Quantity, number>>;

// Codes can carry a channel suffix, e.g. `cur_power1`. Calibration codes such
// as `power_coe` must not match, so the list is exact.
const CODES: Record<Quantity, string[]> = {
  power: ["cur_power", "active_power", "power", "total_power"],
  voltage: ["cur_voltage", "voltage"],
  current: ["cur_current", "electric_current", "current"],
  // Cumulative totals only. Codes such as `add_ele` report the increment since
  // the last report, which cannot feed a cumulative Matter attribute.
  energy: [
    "total_energy",
    "forward_energy_total",
    "total_forward_energy",
    "energy_forward",
    "electricity_total",
  ],
};

const UNITS: Record<Quantity, Record<string, number>> = {
  power: { mw: 1, w: 1e3, kw: 1e6 },
  voltage: { mv: 1, v: 1e3, kv: 1e6 },
  current: { ma: 1, a: 1e3 },
  energy: { mwh: 1, wh: 1e3, kwh: 1e6 },
};

function quantityOf(code: string): Quantity | undefined {
  const base = code.replace(/\d+$/, "");
  for (const [quantity, codes] of Object.entries(CODES)) {
    if (codes.includes(base)) {
      return quantity as Quantity;
    }
  }
  return undefined;
}

function unitFactor(quantity: Quantity, unit: string): number | undefined {
  // Tuya writes units as "W", "kwh", "kW·h", "kW.h"; normalise before lookup.
  return UNITS[quantity][unit.toLowerCase().replace(/[^a-z]/g, "")];
}

/** What a Tuya device offers over Matter. */
export type Capabilities = {
  measurements: Measurement[];
  /** Tuya property code of the power switch, e.g. `switch_1`. */
  switchCode?: string;
};

export function capabilitiesOf(properties: TuyaProperty[]): Capabilities {
  return {
    measurements: measurementsOf(properties),
    switchCode: switchCodeOf(properties),
  };
}

/**
 * Finds the writable on/off property. `switch_inching` and other settings are
 * not switches, so the code must match exactly.
 */
function switchCodeOf(properties: TuyaProperty[]): string | undefined {
  return properties.find(
    ({ code, accessMode, typeSpec }) =>
      /^switch(_\d+)?$/.test(code) &&
      typeSpec.type === "bool" &&
      accessMode.includes("w"),
  )?.code;
}

/**
 * Selects the measurements a Tuya device reports. Returns an empty list for
 * devices without electricity metering.
 */
function measurementsOf(properties: TuyaProperty[]): Measurement[] {
  const measurements = new Map<Quantity, Measurement>();

  for (const { code, typeSpec } of properties) {
    const quantity = quantityOf(code);
    if (!quantity || measurements.has(quantity) || !typeSpec.unit) {
      continue;
    }

    const factor = unitFactor(quantity, typeSpec.unit);
    if (factor === undefined) {
      continue;
    }

    measurements.set(quantity, {
      quantity,
      code,
      factor: factor / 10 ** (typeSpec.scale ?? 0),
    });
  }

  // Voltage or current alone is not a useful meter.
  const metering = measurements.has("power") || measurements.has("energy");
  return metering ? [...measurements.values()] : [];
}

/** Converts Tuya property values into Matter milli-units. */
export function readMeasurements(
  measurements: Measurement[],
  values: TuyaPropertyValue[],
): Readings {
  const byCode = new Map(values.map(({ code, value }) => [code, value]));
  const readings: Readings = {};

  for (const { quantity, code, factor } of measurements) {
    const value = byCode.get(code);
    if (typeof value === "number") {
      readings[quantity] = Math.round(value * factor);
    }
  }

  return readings;
}
