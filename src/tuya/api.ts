import { createHash, createHmac, randomUUID } from "node:crypto";

export type TuyaResponse<T> =
  | { success: true; result: T; t: number }
  | { success: false; result?: unknown; code: number; msg: string; t: number };

export type TuyaDevice = {
  id: string;
  name: string;
  category: string;
  online: boolean;
  product_name?: string;
};

/** One entry of a Tuya thing model, e.g. `cur_power`. */
export type TuyaProperty = {
  code: string;
  accessMode: string;
  typeSpec: { type: string; unit?: string; scale?: number };
};

export type TuyaPropertyValue = { code: string; value: unknown };

type Token = {
  accessToken: string;
  refreshToken: string;
  uid: string;
  expiresAt: number;
};

const TOKEN_REFRESH_MARGIN_MS = 60_000;
const DEVICE_PAGE_SIZE = 100;

export class TuyaApiError extends Error {
  constructor(
    readonly code: number,
    readonly msg: string,
    path: string,
  ) {
    super(`tuya api ${path} failed: ${msg} (code ${code})`);
    this.name = "TuyaApiError";
  }
}

export class TuyaApi {
  #token?: Token;

  constructor(
    private readonly endpoint: string,
    private readonly accessId: string,
    private readonly accessKey: string,
  ) {}

  /** Authenticates as the cloud project itself. */
  async login(): Promise<void> {
    this.#token = undefined;
    this.#setToken(
      await this.request("GET", "/v1.0/token", { query: { grant_type: 1 } }),
    );
  }

  /** Lists every device of the app accounts linked to the cloud project. */
  async devices(): Promise<TuyaDevice[]> {
    const devices: TuyaDevice[] = [];
    let cursor: string | undefined;

    do {
      const page = await this.request<{
        devices: TuyaDevice[];
        has_more: boolean;
        last_row_key: string;
      }>("GET", "/v1.0/iot-01/associated-users/devices", {
        query: {
          size: DEVICE_PAGE_SIZE,
          ...(cursor ? { last_row_key: cursor } : {}),
        },
      });
      devices.push(...page.devices);
      cursor = page.has_more ? page.last_row_key : undefined;
    } while (cursor);

    return devices;
  }

  /** Reads the thing model, which describes the unit and scale of each property. */
  async properties(deviceId: string): Promise<TuyaProperty[]> {
    const { model } = await this.request<{ model: string }>(
      "GET",
      `/v2.0/cloud/thing/${deviceId}/model`,
    );
    const { services } = JSON.parse(model) as {
      services: { properties: TuyaProperty[] }[];
    };
    return services.flatMap((service) => service.properties);
  }

  /** Reads the last reported value of every device property. */
  async values(deviceId: string): Promise<TuyaPropertyValue[]> {
    const { properties } = await this.request<{
      properties: TuyaPropertyValue[];
    }>("GET", `/v2.0/cloud/thing/${deviceId}/shadow/properties`);
    return properties;
  }

  async request<T>(
    method: "GET" | "POST",
    path: string,
    options: { query?: Record<string, string | number>; body?: unknown } = {},
  ): Promise<T> {
    await this.#refreshTokenIfNeeded(path);

    const signedPath = signedUrl(path, options.query);
    const timestamp = Date.now();
    const nonce = randomUUID();
    // Token management calls are signed without a token, even once we have one.
    const token = isTokenApi(path) ? "" : (this.#token?.accessToken ?? "");
    const payload =
      options.body === undefined ? "" : JSON.stringify(options.body);

    const stringToSign = [
      method,
      createHash("sha256").update(payload).digest("hex"),
      `client_id:${this.accessId}\n`,
      signedPath,
    ].join("\n");

    const sign = createHmac("sha256", this.accessKey)
      .update([this.accessId, token, timestamp, nonce, stringToSign].join(""))
      .digest("hex")
      .toUpperCase();

    const response = await fetch(new URL(signedPath, this.endpoint), {
      method,
      headers: {
        client_id: this.accessId,
        access_token: this.#token?.accessToken ?? "",
        t: `${timestamp}`,
        nonce,
        "Signature-Headers": "client_id",
        sign,
        sign_method: "HMAC-SHA256",
        lang: "en",
        "Content-Type": "application/json",
      },
      body: payload || undefined,
    });

    if (!response.ok) {
      throw new Error(
        `tuya api ${path} failed: HTTP ${response.status} ${response.statusText}`,
      );
    }

    const json = (await response.json()) as TuyaResponse<T>;
    if (!json.success) {
      throw new TuyaApiError(json.code, json.msg, path);
    }
    return json.result;
  }

  #setToken(result: {
    access_token: string;
    refresh_token: string;
    uid: string;
    expire_time: number;
  }): void {
    this.#token = {
      accessToken: result.access_token,
      refreshToken: result.refresh_token,
      uid: result.uid,
      expiresAt: Date.now() + result.expire_time * 1000,
    };
  }

  async #refreshTokenIfNeeded(path: string): Promise<void> {
    const token = this.#token;
    if (
      !token ||
      isTokenApi(path) ||
      Date.now() + TOKEN_REFRESH_MARGIN_MS < token.expiresAt
    ) {
      return;
    }
    this.#setToken(
      await this.request("GET", `/v1.0/token/${token.refreshToken}`),
    );
  }
}

function isTokenApi(path: string): boolean {
  return path.startsWith("/v1.0/token");
}

function signedUrl(
  path: string,
  query?: Record<string, string | number>,
): string {
  if (!query) {
    return path;
  }
  const params = new URLSearchParams();
  for (const key of Object.keys(query).sort()) {
    params.append(key, `${query[key]}`);
  }
  return `${path}?${params}`;
}
