import { loadAddresses, saveAddresses } from "./addresses.js";
import { loadConfig } from "./config.js";
import { Devices } from "./devices.js";
import { Bridge } from "./matter/bridge.js";
import { TuyaApi } from "./tuya/api.js";
import { load } from "./tuya/enrollment.js";
import { TuyaLocal } from "./tuya/local.js";
import { startWeb } from "./web.js";

// Kept inside a function: the released binary is CommonJS, which has no
// top-level await.
async function main() {
  const config = loadConfig();

  const enrolled = await load(config.enrollmentFile, async () => {
    const { endpoint, accessId, accessKey } = config.cloud;
    if (!accessId || !accessKey) {
      throw new Error(
        `no enrolment in ${config.enrollmentFile}, so TUYA_ACCESS_ID and ` +
          "TUYA_ACCESS_KEY are needed once to fetch the local keys",
      );
    }
    const api = new TuyaApi(endpoint, accessId, accessKey);
    await api.login();
    return api;
  });

  const tuya = new TuyaLocal(
    enrolled,
    config.subnet,
    await loadAddresses(config.addressFile),
    (addresses) => void saveAddresses(config.addressFile, addresses),
  );

  const bridge = new Bridge(config.matter);
  await bridge.start();

  // The page is served before the search, which can take a while on a subnet
  // that has never been searched.
  const devices = new Devices(tuya, bridge, config.stateFile);
  await startWeb(config.webPort, devices, bridge);
  console.log(
    `Choose the devices to expose at http://localhost:${config.webPort}`,
  );

  console.log(`searching ${config.subnet} for ${enrolled.length} devices`);
  await devices.load();
  const found = devices.list().filter(({ online }) => online).length;
  console.log(`${found} of ${enrolled.length} devices answered`);
  await devices.poll();

  const timer = setInterval(() => void devices.poll(), config.pollIntervalMs);

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      clearInterval(timer);
      void bridge.stop().then(() => process.exit(0));
    });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
