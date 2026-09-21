import assert from "node:assert/strict";
import { test } from "node:test";

import { hostsOf } from "./discovery.js";

test("expands a /24, without the network and broadcast addresses", () => {
  const hosts = hostsOf("192.168.107.0/24");

  assert.equal(hosts.length, 254);
  assert.equal(hosts[0], "192.168.107.1");
  assert.equal(hosts.at(-1), "192.168.107.254");
});

test("expands a block that is not aligned to its mask", () => {
  // 192.168.1.77/24 names the same network as 192.168.1.0/24.
  assert.deepEqual(hostsOf("192.168.1.77/24"), hostsOf("192.168.1.0/24"));
});

test("expands a /30 and a single address", () => {
  assert.deepEqual(hostsOf("10.0.0.0/30"), ["10.0.0.1", "10.0.0.2"]);
  assert.deepEqual(hostsOf("10.0.0.5/32"), ["10.0.0.5"]);
});

test("crosses an octet boundary", () => {
  const hosts = hostsOf("10.0.0.0/23");

  assert.equal(hosts.length, 510);
  assert.ok(hosts.includes("10.0.0.255"));
  assert.ok(hosts.includes("10.0.1.0"));
});

test("refuses what is not a subnet", () => {
  for (const bad of ["192.168.1.1", "not a subnet", "", "192.168.1.0/"]) {
    assert.throws(() => hostsOf(bad), /CIDR/);
  }
  assert.throws(() => hostsOf("192.168.1.300/24"), /usable/);
  assert.throws(() => hostsOf("192.168.1.0/33"), /usable/);
});

test("ignores space around the block", () => {
  assert.deepEqual(hostsOf("  10.0.0.0/30  "), hostsOf("10.0.0.0/30"));
});

test("refuses a block too large to scan", () => {
  assert.throws(() => hostsOf("10.0.0.0/16"), /too many/);
});
