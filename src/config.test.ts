import assert from "node:assert/strict";
import { test } from "node:test";

import { loadConfig } from "./config.js";

test("delegates the default passcode to Matter and preserves explicit overrides", (t) => {
  const subnet = process.env.TUYA_SUBNET;
  const passcode = process.env.MATTER_PASSCODE;
  t.after(() => {
    if (subnet === undefined) delete process.env.TUYA_SUBNET;
    else process.env.TUYA_SUBNET = subnet;
    if (passcode === undefined) delete process.env.MATTER_PASSCODE;
    else process.env.MATTER_PASSCODE = passcode;
  });
  process.env.TUYA_SUBNET = "192.0.2.1/32";
  delete process.env.MATTER_PASSCODE;
  assert.equal(loadConfig().matter.passcode, -1);
  process.env.MATTER_PASSCODE = " ";
  assert.equal(loadConfig().matter.passcode, -1);
  process.env.MATTER_PASSCODE = "34567890";
  assert.equal(loadConfig().matter.passcode, 34567890);
});
