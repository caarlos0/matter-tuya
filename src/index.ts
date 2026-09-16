import { loadConfig } from "./config.js";
import { Bridge } from "./matter/bridge.js";
import { TuyaApi, type TuyaDevice } from "./tuya/api.js";
import { measurementsOf, readMeasurements, type Measurement } from "./tuya/meters.js";

type Meter = { device: TuyaDevice; measurements: Measurement[] };

async function findMeters(api: TuyaApi): Promise<Meter[]> {
  const meters: Meter[] = [];
  for (const device of await api.devices()) {
    const measurements = measurementsOf(await api.properties(device.id));
    if (measurements.length > 0) {
      meters.push({ device, measurements });
    }
  }
  return meters;
}

async function poll(api: TuyaApi, bridge: Bridge, meters: Meter[]) {
  for (const { device, measurements } of meters) {
    try {
      const values = await api.values(device.id);
      await bridge.updateMeter(
        device.id,
        true,
        readMeasurements(measurements, values),
      );
    } catch (error) {
      console.error(`failed to read ${device.name}:`, error);
      await bridge.updateMeter(device.id, false, {});
    }
  }
}

async function main() {
  const config = loadConfig();
  const api = new TuyaApi(config.endpoint, config.accessId, config.accessKey);
  await api.login();

  const meters = await findMeters(api);
  if (meters.length === 0) {
    console.error("no Tuya devices with electricity metering found");
    return;
  }

  const bridge = new Bridge(config.matter);
  await bridge.start();

  for (const { device, measurements } of meters) {
    console.log(
      `exposing ${device.name} (${device.category}): ` +
        measurements.map((m) => m.quantity).join(", "),
    );
    await bridge.addMeter({
      id: device.id,
      name: device.name,
      vendorName: "Tuya",
      productName: device.product_name ?? device.category,
      reachable: device.online,
      measurements,
    });
  }

  const codes = bridge.commissioning;
  if (codes) {
    console.log(`\nPair this bridge with: ${codes.manualPairingCode}`);
    console.log(`${codes.qrPairingCode}\n`);
  }

  await poll(api, bridge, meters);
  const timer = setInterval(
    () => void poll(api, bridge, meters),
    config.pollIntervalMs,
  );

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      clearInterval(timer);
      void bridge.stop().then(() => process.exit(0));
    });
  }
}

await main();
