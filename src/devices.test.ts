import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Devices } from "./devices.js";
import type { Bridge } from "./matter/bridge.js";
import type { TuyaApi, TuyaDevice, TuyaProperty } from "./tuya/api.js";

const METER: TuyaProperty[] = [
  { code: "cur_power", typeSpec: { unit: "W", scale: 1 } },
];
const NO_METER: TuyaProperty[] = [
  { code: "switch_1", typeSpec: { unit: undefined, scale: 0 } },
];

function device(id: string, name: string): TuyaDevice {
  return { id, name, category: "cz", online: true, product_name: "Plug" };
}

function fakeApi(devices: TuyaDevice[], models: Record<string, TuyaProperty[]>) {
  return {
    devices: async () => devices,
    properties: async (id: string) => models[id] ?? [],
    values: async () => [{ code: "cur_power", value: 12 }],
  } as unknown as TuyaApi;
}

function fakeBridge() {
  const bridged = new Set<string>();
  const bridge = {
    addMeter: async ({ id }: { id: string }) => void bridged.add(id),
    removeMeter: async (id: string) => void bridged.delete(id),
    updateMeter: async () => {},
  } as unknown as Bridge;
  return { bridge, bridged };
}

async function stateFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "tuya-matter-")), "devices.json");
}

test("bridges a device only after the user enables it", async () => {
  const { bridge, bridged } = fakeBridge();
  const devices = new Devices(
    fakeApi([device("a", "Meter")], { a: METER }),
    bridge,
    await stateFile(),
  );

  await devices.load();
  assert.deepEqual([...bridged], []);
  assert.deepEqual(devices.list(), [
    {
      id: "a",
      name: "Meter",
      productName: "Plug",
      online: true,
      quantities: ["power"],
      enabled: false,
      readings: {},
    },
  ]);

  await devices.setEnabled("a", true);
  assert.deepEqual([...bridged], ["a"]);

  await devices.setEnabled("a", false);
  assert.deepEqual([...bridged], []);
});

test("refuses to expose a device without metering", async () => {
  const { bridge } = fakeBridge();
  const devices = new Devices(
    fakeApi([device("a", "Switch")], { a: NO_METER }),
    bridge,
    await stateFile(),
  );
  await devices.load();

  await assert.rejects(
    devices.setEnabled("a", true),
    /reports no electricity/,
  );
  await assert.rejects(devices.setEnabled("nope", true), /unknown device/);
});

test("restores the selection of an earlier run", async () => {
  const file = await stateFile();
  const api = fakeApi([device("a", "Meter")], { a: METER });

  const first = fakeBridge();
  const devices = new Devices(api, first.bridge, file);
  await devices.load();
  await devices.setEnabled("a", true);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), ["a"]);

  const second = fakeBridge();
  await new Devices(api, second.bridge, file).load();
  assert.deepEqual([...second.bridged], ["a"]);
});

test("unbridges a device that left the Tuya account", async () => {
  const file = await stateFile();
  const present = [device("a", "Meter")];
  const { bridge, bridged } = fakeBridge();
  const devices = new Devices(
    fakeApi(present, { a: METER }),
    bridge,
    file,
  );

  await devices.load();
  await devices.setEnabled("a", true);
  assert.deepEqual([...bridged], ["a"]);

  present.length = 0;
  await devices.refresh();

  assert.deepEqual([...bridged], []);
  assert.deepEqual(devices.list(), []);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), []);
});

test("keeps the last readings for enabled devices", async () => {
  const { bridge } = fakeBridge();
  const devices = new Devices(
    fakeApi([device("a", "Meter")], { a: METER }),
    bridge,
    await stateFile(),
  );

  await devices.load();
  await devices.setEnabled("a", true);
  await devices.poll();

  assert.deepEqual(devices.list()[0]?.readings, { power: 1200 });
});
