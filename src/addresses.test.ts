import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { loadAddresses } from "./addresses.js";

test("ignores unauthenticated legacy address hints while retaining keyed versions", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "tuya-addresses-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "addresses.json");
  await writeFile(file, JSON.stringify({
    legacy: { host: "192.0.2.1", version: "3.1" },
    encrypted: { host: "192.0.2.2", version: "3.3" },
    modern: { host: "192.0.2.3", version: "3.5" },
  }));
  const addresses = await loadAddresses(file);
  assert.equal(addresses.has("legacy"), false);
  assert.equal(addresses.get("encrypted")?.version, "3.3");
  assert.equal(addresses.get("modern")?.version, "3.5");
});
