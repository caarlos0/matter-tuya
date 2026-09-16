import { homedir } from "node:os";
import { join } from "node:path";

export type Config = {
  endpoint: string;
  accessId: string;
  accessKey: string;
  pollIntervalMs: number;
  stateFile: string;
  webPort: number;
  matter: {
    passcode: number;
    discriminator: number;
    port: number;
  };
};

// Tuya rejects credentials sent to the wrong data center, so the country code
// selects the default endpoint.
const ENDPOINT_BY_COUNTRY: Record<number, string> = {
  86: "https://openapi.tuyacn.com",
  91: "https://openapi.tuyain.com",
};

const EUROPE_COUNTRIES = new Set([
  7, 20, 27, 30, 31, 32, 33, 34, 36, 39, 40, 41, 43, 44, 45, 46, 47, 48, 49, 61,
  65, 90, 92, 93, 94, 212, 213, 216, 218, 220, 221, 222, 223, 224, 225, 226,
  227, 228, 229, 230, 231, 232, 233, 234, 235, 236, 237, 238, 240, 241, 242,
  243, 244, 248, 250, 251, 252, 253, 254, 255, 256, 257, 258, 260, 261, 262,
  263, 264, 265, 266, 267, 268, 269, 291, 297, 298, 299, 350, 351, 352, 353,
  354, 355, 356, 357, 358, 359, 370, 371, 372, 373, 374, 375, 376, 377, 378,
  379, 380, 381, 382, 385, 386, 387, 389, 420, 421, 423, 501, 503, 504, 505,
  506, 507, 508, 509, 590, 592, 596, 673, 676, 679, 680, 681, 685, 687, 688,
  689, 691, 692, 855, 856, 880, 960, 961, 962, 964, 965, 966, 967, 968, 971,
  972, 973, 974, 975, 976, 977, 992, 993, 994, 995, 996,
]);

function defaultEndpoint(countryCode: number): string {
  const direct = ENDPOINT_BY_COUNTRY[countryCode];
  if (direct) {
    return direct;
  }
  return EUROPE_COUNTRIES.has(countryCode)
    ? "https://openapi.tuyaeu.com"
    : "https://openapi.tuyaus.com";
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`missing required environment variable ${name}`);
  }
  return value;
}

function optionalNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`environment variable ${name} is not a number: ${raw}`);
  }
  return value;
}

/**
 * Every setting is prefixed. Bare names such as `ACCESS_ID` collide with other
 * tools, and a real environment variable silently wins over the `.env` file.
 */
export function loadConfig(): Config {
  const countryCode = optionalNumber("TUYA_COUNTRY_CODE", 1);

  return {
    endpoint: process.env.TUYA_ENDPOINT?.trim() || defaultEndpoint(countryCode),
    accessId: required("TUYA_ACCESS_ID"),
    accessKey: required("TUYA_ACCESS_KEY"),
    pollIntervalMs: optionalNumber("TUYA_POLL_INTERVAL", 30) * 1000,
    stateFile:
      process.env.TUYA_STATE_FILE?.trim() ||
      join(
        process.env.MATTER_STORAGE_PATH?.trim() || join(homedir(), ".matter"),
        "tuya-matter-devices.json",
      ),
    webPort: optionalNumber("TUYA_WEB_PORT", 8080),
    matter: {
      passcode: optionalNumber("MATTER_PASSCODE", 20202021),
      discriminator: optionalNumber("MATTER_DISCRIMINATOR", 3840),
      port: optionalNumber("MATTER_PORT", 5540),
    },
  };
}
