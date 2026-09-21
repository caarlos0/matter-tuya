import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { TuyaApi, TuyaProperty } from "./api.js";
import { codesOf, decode, encode, load, type Enrolled } from "./enrollment.js";

const KEY = "0123456789abcdef";

const PROPERTIES: TuyaProperty[] = [
  { code: "switch_1", accessMode: "rw", abilityId: 1, typeSpec: { type: "bool" } },
  {
    code: "cur_power",
    accessMode: "ro",
    abilityId: 19,
    typeSpec: { type: "value", unit: "W", scale: 1 },
  },
];

function enrolled(id = "a"): Enrolled {
  return { id, name: "Plug", productName: "Plug", key: KEY, properties: PROPERTIES };
}

function fakeApi(devices: unknown[], properties = PROPERTIES) {
  let calls = 0;
  const api = {
    devices: async () => {
      calls++;
      return devices;
    },
    properties: async () => properties,
  } as unknown as TuyaApi;
  return { api, calls: () => calls };
}

async function file(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "tuya-enrol-")), "enrollment.json");
}

test("maps each data point number to its property code", () => {
  assert.deepEqual(
    [...codesOf(enrolled())],
    [
      [1, "switch_1"],
      [19, "cur_power"],
    ],
  );
});

test("round-trips an enrolment", () => {
  assert.deepEqual(decode(encode([enrolled()])), [enrolled()]);
});

test("rejects an enrolment it cannot use", () => {
  assert.equal(decode(undefined), undefined);
  assert.equal(decode("not json"), undefined);
  assert.equal(decode("{}"), undefined);
  assert.equal(decode(JSON.stringify({ format: 1, devices: [] })), undefined);
  // A file from a future or past format must be replaced, not trusted.
  assert.equal(
    decode(JSON.stringify({ format: 99, devices: [enrolled()] })),
    undefined,
  );
  // A key of the wrong length cannot open a session, so the file is no good.
  assert.equal(
    decode(JSON.stringify({ format: 1, devices: [{ ...enrolled(), key: "short" }] })),
    undefined,
  );
});

test("asks the cloud once, then never again", async () => {
  const path = await file();
  const { api, calls } = fakeApi([
    { id: "a", name: "Plug", category: "cz", product_name: "Plug", local_key: KEY },
  ]);

  const first = await load(path, async () => api);
  assert.deepEqual(first.map(({ id }) => id), ["a"]);
  assert.equal(calls(), 1);

  // The second run must not need the cloud at all.
  const second = await load(path, async () => {
    throw new Error("the cloud was asked again");
  });
  assert.deepEqual(second, first);
  assert.equal(calls(), 1);
});

test("replaces a stored enrolment that cannot be used", async () => {
  const path = await file();
  await writeFile(path, "{ this is not json");
  const { api, calls } = fakeApi([
    { id: "a", name: "Plug", category: "cz", local_key: KEY },
  ]);

  assert.deepEqual((await load(path, async () => api)).map(({ id }) => id), ["a"]);
  assert.equal(calls(), 1);
  assert.ok(decode(await readFile(path, "utf8")));
});

test("skips a device that cannot be reached locally", async () => {
  const path = await file();
  const { api } = fakeApi([
    { id: "a", name: "No key", category: "cz" },
    { id: "b", name: "Plug", category: "cz", local_key: KEY },
  ]);

  assert.deepEqual((await load(path, async () => api)).map(({ id }) => id), ["b"]);
});

test("fails when no device can be reached locally", async () => {
  const path = await file();
  const { api } = fakeApi([{ id: "a", name: "No key", category: "cz" }]);

  await assert.rejects(load(path, async () => api), /no device/);
});

test("skips a device whose thing model names no data point", async () => {
  const path = await file();
  const { api } = fakeApi(
    [
      { id: "a", name: "Plug", category: "cz", local_key: KEY },
      { id: "b", name: "Meter", category: "cz", local_key: KEY },
    ],
    [{ code: "switch_1", accessMode: "rw", typeSpec: { type: "bool" } }],
  );

  await assert.rejects(load(path, async () => api), /no device/);
});
