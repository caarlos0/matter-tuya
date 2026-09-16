import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Devices } from "./devices.js";
import type { Bridge } from "./matter/bridge.js";
import type { TuyaApi, TuyaDevice, TuyaProperty } from "./tuya/api.js";

const POWER: TuyaProperty = {
  code: "cur_power",
  accessMode: "ro",
  typeSpec: { type: "value", unit: "W", scale: 1 },
};
const SWITCH: TuyaProperty = {
  code: "switch_1",
  accessMode: "rw",
  typeSpec: { type: "bool" },
};

const INERT: TuyaProperty = {
  code: "net_state",
  accessMode: "ro",
  typeSpec: { type: "enum" },
};

const METER = [POWER];

function device(id: string, name: string): TuyaDevice {
  return { id, name, category: "cz", online: true, product_name: "Plug" };
}

function fakeApi(
  devices: TuyaDevice[],
  models: Record<string, TuyaProperty[]>,
) {
  const written: [string, string, boolean][] = [];
  const api = {
    devices: async () => devices,
    properties: async (id: string) => models[id] ?? [],
    values: async () => [
      { code: "cur_power", value: 12 },
      { code: "switch_1", value: true },
    ],
    setProperty: async (id: string, code: string, value: boolean) =>
      void written.push([id, code, value]),
  } as unknown as TuyaApi;
  return { api, written };
}

type Switcher = (on: boolean) => Promise<void>;

function fakeBridge() {
  const bridged = new Map<string, Switcher | undefined>();
  const bridge = {
    addDevice: async ({ id }: { id: string }, setSwitch?: Switcher) =>
      void bridged.set(id, setSwitch),
    removeDevice: async (id: string) => void bridged.delete(id),
    updateDevice: async () => {},
  } as unknown as Bridge;
  return { bridge, bridged };
}

async function stateFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "tuya-matter-")), "devices.json");
}

test("bridges a device only after the user enables it", async () => {
  const { bridge, bridged } = fakeBridge();
  const devices = new Devices(
    fakeApi([device("a", "Meter")], { a: METER }).api,
    bridge,
    await stateFile(),
  );

  await devices.load();
  assert.deepEqual([...bridged.keys()], []);
  assert.deepEqual(devices.list(), [
    {
      id: "a",
      name: "Meter",
      productName: "Plug",
      online: true,
      quantities: ["power"],
      switchable: false,
      enabled: false,
      readings: {},
      on: undefined,
    },
  ]);

  await devices.setEnabled("a", true);
  assert.deepEqual([...bridged.keys()], ["a"]);

  await devices.setEnabled("a", false);
  assert.deepEqual([...bridged.keys()], []);
});

test("refuses to expose a device with no switch and no metering", async () => {
  const { bridge } = fakeBridge();
  const devices = new Devices(
    fakeApi([device("a", "Sensor")], { a: [INERT] }).api,
    bridge,
    await stateFile(),
  );
  await devices.load();

  await assert.rejects(devices.setEnabled("a", true), /no switch/);
  await assert.rejects(devices.setEnabled("nope", true), /unknown device/);
});

test("forwards a Matter on/off command to Tuya", async () => {
  const { api, written } = fakeApi([device("a", "Plug")], { a: [SWITCH, POWER] });
  const { bridge, bridged } = fakeBridge();
  const devices = new Devices(api, bridge, await stateFile());

  await devices.load();
  assert.equal(devices.list()[0]?.switchable, true);

  await devices.setEnabled("a", true);
  await bridged.get("a")?.(false);

  assert.deepEqual(written, [["a", "switch_1", false]]);
  assert.equal(devices.list()[0]?.on, false);
});

test("exposes a switch-only device", async () => {
  const { bridge, bridged } = fakeBridge();
  const devices = new Devices(
    fakeApi([device("a", "Plug")], { a: [SWITCH] }).api,
    bridge,
    await stateFile(),
  );

  await devices.load();
  await devices.setEnabled("a", true);

  assert.deepEqual([...bridged.keys()], ["a"]);
  assert.deepEqual(devices.list()[0]?.quantities, []);
});

test("restores the selection of an earlier run", async () => {
  const file = await stateFile();
  const { api } = fakeApi([device("a", "Meter")], { a: METER });

  const first = fakeBridge();
  const devices = new Devices(api, first.bridge, file);
  await devices.load();
  await devices.setEnabled("a", true);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), ["a"]);

  const second = fakeBridge();
  await new Devices(api, second.bridge, file).load();
  assert.deepEqual([...second.bridged.keys()], ["a"]);
});

test("unbridges a device that left the Tuya account", async () => {
  const file = await stateFile();
  const present = [device("a", "Meter")];
  const { bridge, bridged } = fakeBridge();
  const devices = new Devices(fakeApi(present, { a: METER }).api, bridge, file);

  await devices.load();
  await devices.setEnabled("a", true);
  assert.deepEqual([...bridged.keys()], ["a"]);

  present.length = 0;
  await devices.refresh();

  assert.deepEqual([...bridged.keys()], []);
  assert.deepEqual(devices.list(), []);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), []);
});

test("keeps the last readings for enabled devices", async () => {
  const { bridge } = fakeBridge();
  const devices = new Devices(
    fakeApi([device("a", "Meter")], { a: METER }).api,
    bridge,
    await stateFile(),
  );

  await devices.load();
  await devices.setEnabled("a", true);
  await devices.poll();

  assert.deepEqual(devices.list()[0]?.readings, { power: 1200 });
});

test("publishes the switch state as soon as a device is exposed", async () => {
  const updates: unknown[] = [];
  const bridge = {
    addDevice: async () => {},
    removeDevice: async () => {},
    updateDevice: async (_id: string, state: unknown) => void updates.push(state),
  } as unknown as Bridge;

  const devices = new Devices(
    fakeApi([device("a", "Plug")], { a: [SWITCH, POWER] }).api,
    bridge,
    await stateFile(),
  );
  await devices.load();
  await devices.setEnabled("a", true);

  assert.deepEqual(updates, [
    { reachable: true, readings: { power: 1200 }, on: true },
  ]);
});
