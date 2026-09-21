import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Devices } from "./devices.js";
import type { Bridge } from "./matter/bridge.js";
import type { TuyaProperty } from "./tuya/api.js";
import type { Enrolled } from "./tuya/enrollment.js";
import type { TuyaLocal } from "./tuya/local.js";

const POWER: TuyaProperty = {
  code: "cur_power",
  accessMode: "ro",
  abilityId: 19,
  typeSpec: { type: "value", unit: "W", scale: 1 },
};
const SWITCH: TuyaProperty = {
  code: "switch_1",
  accessMode: "rw",
  abilityId: 1,
  typeSpec: { type: "bool" },
};
const INERT: TuyaProperty = {
  code: "net_state",
  accessMode: "ro",
  abilityId: 113,
  typeSpec: { type: "enum" },
};

function device(id: string, name: string, properties: TuyaProperty[]): Enrolled {
  return { id, name, productName: "Plug", key: "0123456789abcdef", properties };
}

type Switcher = (on: boolean) => Promise<void>;

function fakeTuya(devices: Enrolled[], offline: string[] = []) {
  const written: [string, string, boolean][] = [];
  let searches = 0;
  const tuya = {
    devices,
    reachable: (id: string) => !offline.includes(id),
    discover: async () => void searches++,
    values: async (id: string) => {
      if (offline.includes(id)) {
        throw new Error(`${id} answered nowhere`);
      }
      return [
        { code: "cur_power", value: 12 },
        { code: "switch_1", value: true },
      ];
    },
    setProperty: async (id: string, code: string, value: boolean) =>
      void written.push([id, code, value]),
  } as unknown as TuyaLocal;
  return { tuya, written, searches: () => searches };
}

function fakeBridge() {
  const bridged = new Map<string, Switcher | undefined>();
  const updates: unknown[] = [];
  const bridge = {
    addDevice: async ({ id }: { id: string }, setSwitch?: Switcher) =>
      void bridged.set(id, setSwitch),
    removeDevice: async (id: string) => void bridged.delete(id),
    updateDevice: async (_id: string, state: unknown) => void updates.push(state),
  } as unknown as Bridge;
  return { bridge, bridged, updates };
}

async function stateFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "tuya-matter-")), "devices.json");
}

test("bridges a device only after the user enables it", async () => {
  const { bridge, bridged } = fakeBridge();
  const { tuya } = fakeTuya([device("a", "Meter", [POWER])]);
  const devices = new Devices(tuya, bridge, await stateFile());

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
  const { tuya } = fakeTuya([device("a", "Sensor", [INERT])]);
  const devices = new Devices(tuya, bridge, await stateFile());
  await devices.load();

  await assert.rejects(devices.setEnabled("a", true), /no switch/);
  await assert.rejects(devices.setEnabled("nope", true), /unknown device/);
});

test("forwards a Matter on/off command to the device", async () => {
  const { bridge, bridged } = fakeBridge();
  const { tuya, written } = fakeTuya([device("a", "Plug", [SWITCH, POWER])]);
  const devices = new Devices(tuya, bridge, await stateFile());

  await devices.load();
  assert.equal(devices.list()[0]?.switchable, true);

  await devices.setEnabled("a", true);
  await bridged.get("a")?.(false);

  assert.deepEqual(written, [["a", "switch_1", false]]);
  assert.equal(devices.list()[0]?.on, false);
});

test("exposes a switch-only device", async () => {
  const { bridge, bridged } = fakeBridge();
  const { tuya } = fakeTuya([device("a", "Plug", [SWITCH])]);
  const devices = new Devices(tuya, bridge, await stateFile());

  await devices.load();
  await devices.setEnabled("a", true);

  assert.deepEqual([...bridged.keys()], ["a"]);
  assert.deepEqual(devices.list()[0]?.quantities, []);
});

test("restores the selection of an earlier run", async () => {
  const file = await stateFile();
  const enrolled = [device("a", "Meter", [POWER])];

  const first = fakeBridge();
  const devices = new Devices(fakeTuya(enrolled).tuya, first.bridge, file);
  await devices.load();
  await devices.setEnabled("a", true);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), ["a"]);

  const second = fakeBridge();
  await new Devices(fakeTuya(enrolled).tuya, second.bridge, file).load();
  assert.deepEqual([...second.bridged.keys()], ["a"]);
});

test("lists a device that does not answer, and marks it offline", async () => {
  const { bridge } = fakeBridge();
  const { tuya } = fakeTuya([device("a", "Plug", [SWITCH])], ["a"]);
  const devices = new Devices(tuya, bridge, await stateFile());
  await devices.load();

  assert.equal(devices.list()[0]?.online, false);
});

test("reports an unreachable device to Matter, and keeps it bridged", async () => {
  const { bridge, bridged, updates } = fakeBridge();
  const { tuya } = fakeTuya([device("a", "Plug", [SWITCH])], ["a"]);
  const devices = new Devices(tuya, bridge, await stateFile());

  await devices.load();
  await devices.setEnabled("a", true);

  assert.deepEqual([...bridged.keys()], ["a"]);
  assert.deepEqual(updates, [{ reachable: false, readings: {} }]);
});

test("searches the subnet when it is asked to refresh", async () => {
  const { bridge } = fakeBridge();
  const { tuya, searches } = fakeTuya([device("a", "Meter", [POWER])]);
  const devices = new Devices(tuya, bridge, await stateFile());

  await devices.load();
  await devices.refresh();

  assert.equal(searches(), 2);
});

test("publishes the switch state as soon as a device is exposed", async () => {
  const { bridge, updates } = fakeBridge();
  const { tuya } = fakeTuya([device("a", "Plug", [SWITCH, POWER])]);
  const devices = new Devices(tuya, bridge, await stateFile());

  await devices.load();
  await devices.setEnabled("a", true);

  assert.deepEqual(updates, [
    { reachable: true, readings: { power: 1200 }, on: true },
  ]);
});

test("forces a search when the user asks to refresh", async () => {
  const { bridge } = fakeBridge();
  const forced: boolean[] = [];
  const tuya = {
    devices: [device("a", "Meter", [POWER])],
    reachable: () => true,
    discover: async (force = false) => void forced.push(force),
    values: async () => [],
    setProperty: async () => {},
  } as unknown as TuyaLocal;

  const devices = new Devices(tuya, bridge, await stateFile());
  await devices.load();
  await devices.refresh();

  // Startup and the user both search at once. Only a failed read waits, so
  // that one unreachable device cannot make every poll search the subnet.
  assert.deepEqual(forced, [true, true]);
});
