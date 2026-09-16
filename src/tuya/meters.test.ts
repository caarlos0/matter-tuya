import assert from "node:assert/strict";
import { test } from "node:test";

import type { TuyaProperty } from "./api.js";
import { measurementsOf, readMeasurements } from "./meters.js";

function property(
  code: string,
  unit?: string,
  scale = 0,
): TuyaProperty {
  return { code, accessMode: "ro", typeSpec: { type: "value", unit, scale } };
}

// Thing model of an EKAZA current transformer meter.
const CT_METER = [
  property("add_ele1", "kWh", 2),
  property("cur_power1", "W", 1),
  property("cur_current1", "A", 3),
  property("cur_voltage1", "V", 1),
  property("total_energy1", "kwh", 3),
  property("warn_power1", "W", 0),
];

// Thing model of a metering smart plug.
const PLUG = [
  property("add_ele", undefined, 3),
  property("cur_current", "mA", 0),
  property("cur_power", "W", 1),
  property("cur_voltage", "V", 1),
  property("power_coe", undefined, 0),
];

test("maps channel-suffixed meter properties to Matter milli-units", () => {
  const measurements = measurementsOf(CT_METER);

  assert.deepEqual(
    readMeasurements(measurements, [
      { code: "cur_power1", value: 1174 },
      { code: "cur_current1", value: 4262 },
      { code: "cur_voltage1", value: 1279 },
      { code: "total_energy1", value: 18932 },
    ]),
    {
      power: 117_400, // 117.4 W
      current: 4262, // 4.262 A
      voltage: 127_900, // 127.9 V
      energy: 18_932_000, // 18.932 kWh
    },
  );
});

test("maps plug properties and reports no cumulative energy", () => {
  const measurements = measurementsOf(PLUG);

  assert.deepEqual(
    readMeasurements(measurements, [
      { code: "cur_power", value: 20 },
      { code: "cur_current", value: 129 },
      { code: "cur_voltage", value: 2206 },
      { code: "add_ele", value: 1 },
    ]),
    { power: 2000, current: 129, voltage: 220_600 },
  );
});

test("ignores calibration coefficients", () => {
  assert.equal(
    measurementsOf(PLUG).some(({ code }) => code.endsWith("_coe")),
    false,
  );
});

test("ignores devices without power or energy", () => {
  assert.deepEqual(
    measurementsOf([property("cur_voltage", "V", 1)]),
    [],
  );
});

test("ignores properties with an unknown unit", () => {
  assert.deepEqual(measurementsOf([property("cur_power", "bogus", 1)]), []);
});

test("skips readings the device did not report", () => {
  assert.deepEqual(
    readMeasurements(measurementsOf(PLUG), [{ code: "cur_power", value: 20 }]),
    { power: 2000 },
  );
});
