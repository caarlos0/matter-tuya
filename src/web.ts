import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import type { Devices } from "./devices.js";
import type { Bridge } from "./matter/bridge.js";
import { PAGE } from "./page.js";

/** Serves the device list and the enable/disable controls. */
export function startWeb(
  port: number,
  devices: Devices,
  bridge: Bridge,
): Promise<void> {
  const server = createServer((request, response) => {
    handle(request, response, devices, bridge).catch((error: unknown) => {
      send(response, 500, { error: message(error) });
    });
  });

  return new Promise((resolve) => server.listen(port, resolve));
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  devices: Devices,
  bridge: Bridge,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");

  if (request.method === "GET" && url.pathname === "/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(PAGE);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/state") {
    send(response, 200, {
      devices: devices.list(),
      commissioning: bridge.commissioning ?? null,
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/refresh") {
    await devices.refresh();
    send(response, 200, { devices: devices.list() });
    return;
  }

  const enable = url.pathname.match(/^\/api\/devices\/([^/]+)$/);
  if (request.method === "PUT" && enable) {
    const { enabled } = (await json(request)) as { enabled: boolean };
    try {
      await devices.setEnabled(decodeURIComponent(enable[1]!), enabled);
    } catch (error) {
      send(response, 400, { error: message(error) });
      return;
    }
    send(response, 200, { devices: devices.list() });
    return;
  }

  send(response, 404, { error: "not found" });
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function json(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
