import assert from "node:assert/strict";
import { request } from "node:http";
import { test, type TestContext } from "node:test";

import { isLocalRequest, startWeb } from "./web.js";

async function fixture(t: TestContext) {
  let changes = 0;
  const server = await startWeb(
    0,
    {
      list: () => [],
      refresh: async () => {},
      setEnabled: async () => {
        changes++;
      },
    },
    {
      commissioning: {
        manualPairingCode: "synthetic",
        qrPairingCode: "synthetic",
      },
    },
  );
  t.after(() => new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve()),
  ));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { address, port: address.port, changes: () => changes };
}

function call(
  port: number,
  path = "/api/state",
  headers: Record<string, string> = {},
  method = "GET",
) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: { host: `localhost:${port}`, connection: "close", ...headers },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => { body += chunk; });
        response.on("end", () => resolve({ status: response.statusCode!, body }));
        response.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(method === "PUT" ? '{"enabled":true}' : undefined);
  });
}

test("administration listens only on loopback", async (t) => {
  const { address } = await fixture(t);
  assert.equal(address.address, "127.0.0.1");
});

test("local clients can read pairing details and choose devices", async (t) => {
  const { port, changes } = await fixture(t);
  const state = await call(port);
  assert.equal(state.status, 200);
  assert.equal(JSON.parse(state.body).commissioning.manualPairingCode, "synthetic");
  const updated = await call(
    port, "/api/devices/test", { origin: `http://localhost:${port}` }, "PUT",
  );
  assert.equal(updated.status, 200);
  assert.equal(changes(), 1);
});

test("rejects foreign origins before exposing state or changing devices", async (t) => {
  const { port, changes } = await fixture(t);
  for (const headers of [{ origin: "http://foreign.invalid" }, { origin: "null" }]) {
    assert.equal((await call(port, "/api/state", headers)).status, 403);
    assert.equal((await call(port, "/api/devices/test", headers, "PUT")).status, 403);
  }
  assert.equal(changes(), 0);
});

test("rejects foreign, missing and malformed Host headers", () => {
  for (const host of [
    "foreign.invalid:8080",
    "foreign.invalid",
    undefined,
    "localhost:8080@foreign.invalid",
    "127.0.0.1.foreign.invalid:8080",
  ]) {
    assert.equal(isLocalRequest(host, undefined, 8080), false, String(host));
  }
  assert.equal(isLocalRequest("127.0.0.1:8080", undefined, 8080), true);
  assert.equal(isLocalRequest("localhost:8080", "http://localhost:8080", 8080), true);
});
