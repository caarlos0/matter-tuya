import { createHash, createHmac, randomUUID } from "node:crypto";

type TuyaResponse<T> =
  | { success: true; result: T }
  | { success: false; code: number; msg: string };

export type TuyaDevice = {
  id: string;
  name: string;
  category: string;
  product_name?: string;
  /** The 16 byte key the device demands on the local network. */
  local_key?: string;
};

/** One entry of a Tuya thing model, e.g. `cur_power`. */
export type TuyaProperty = {
  code: string;
  /** `ro`, `rw` or `wr`. Only writable properties accept commands. */
  accessMode: string;
  /** The data point number this property carries on the wire. */
  abilityId?: number;
  typeSpec: { type: string; unit?: string; scale?: number };
};

type Token = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
};

const TOKEN_REFRESH_MARGIN_MS = 60_000;
const DEVICE_PAGE_SIZE = 100;

/**
 * The Tuya cloud, used only to enrol devices.
 *
 * A local key cannot be derived and a data point map is published nowhere
 * else, so the cloud is asked once. It can neither read nor write device
 * state: those calls are absent on purpose, so no reading can ever depend on
 * a cloud that is slow, rate limited, or down.
 */
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
    this.#setToken(await this.#get("/v1.0/token", { grant_type: 1 }));
  }

  /** Lists every device of the app accounts linked to the cloud project. */
  async devices(): Promise<TuyaDevice[]> {
    const devices: TuyaDevice[] = [];
    let cursor: string | undefined;

    do {
      const page = await this.#get<{
        devices: TuyaDevice[];
        has_more: boolean;
        last_row_key: string;
      }>("/v1.0/iot-01/associated-users/devices", {
        size: DEVICE_PAGE_SIZE,
        ...(cursor ? { last_row_key: cursor } : {}),
      });
      devices.push(...page.devices);
      cursor = page.has_more ? page.last_row_key : undefined;
    } while (cursor);

    return devices;
  }

  /** Reads the thing model: the unit and scale of every device property. */
  async properties(deviceId: string): Promise<TuyaProperty[]> {
    const { model } = await this.#get<{ model: string }>(
      `/v2.0/cloud/thing/${deviceId}/model`,
    );
    const { services } = JSON.parse(model) as {
      services: { properties: TuyaProperty[] }[];
    };
    return services.flatMap((service) => service.properties);
  }

  async #get<T>(
    path: string,
    query?: Record<string, string | number>,
  ): Promise<T> {
    return this.#request("GET", signedUrl(path, query));
  }

  async #request<T>(method: "GET", path: string, payload = ""): Promise<T> {
    await this.#refreshTokenIfNeeded(path);

    const timestamp = Date.now();
    const nonce = randomUUID();
    // Token management calls are signed without a token, even once we have one.
    const token = isTokenApi(path) ? "" : (this.#token?.accessToken ?? "");

    const stringToSign = [
      method,
      createHash("sha256").update(payload).digest("hex"),
      `client_id:${this.accessId}\n`,
      path,
    ].join("\n");

    const sign = createHmac("sha256", this.accessKey)
      .update([this.accessId, token, timestamp, nonce, stringToSign].join(""))
      .digest("hex")
      .toUpperCase();

    const response = await fetch(new URL(path, this.endpoint), {
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
      throw new Error(`tuya api ${path} failed: ${json.msg} (code ${json.code})`);
    }
    return json.result;
  }

  #setToken(result: {
    access_token: string;
    refresh_token: string;
    expire_time: number;
  }): void {
    this.#token = {
      accessToken: result.access_token,
      refreshToken: result.refresh_token,
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
    this.#setToken(await this.#get(`/v1.0/token/${token.refreshToken}`));
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
