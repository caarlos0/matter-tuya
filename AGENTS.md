# AGENTS.md

Bridge that exposes Tuya cloud devices as Matter devices on the local network.
A web page lists the account and the user picks which devices to expose.

## Safety

The Tuya devices are real appliances in a home, and some of them are water
heaters. **Never send an on/off command to a real device without explicit
permission for that device.** To exercise the write path safely, read the
current value and write the same value back.

The bridge locks its Matter storage. Always override it when you run a test
instance, or you take over the paired production node:

```sh
TUYA_WEB_PORT=8099 MATTER_PORT=5599 \
  MATTER_STORAGE_PATH=/tmp/tm-test TUYA_STATE_FILE=/tmp/tm-test.json \
  bun src/index.ts
```

## Commands

```sh
bun install
bun start          # run from source
bun test src       # run the tests
bun run typecheck  # tsc --noEmit; bun does not type-check
bun run build      # compile a binary for this machine
bun run reset      # erase the Matter state; refuses while the bridge runs
```

Bun loads `.env` itself. There is no Node, no npm, and no bundler step.

## Layout

| File                          | Role                                                |
| ----------------------------- | --------------------------------------------------- |
| `src/index.ts`                | Startup and the poll timer.                          |
| `src/config.ts`               | Environment settings and the data center default.    |
| `src/devices.ts`              | Registry: which devices exist and which are exposed. |
| `src/state.ts`                | Reads and writes the exposed-device list.            |
| `src/web.ts`                  | HTTP API and page serving.                           |
| `src/page.ts`                 | The web page.                                        |
| `src/tuya/api.ts`             | Tuya cloud client and request signing.               |
| `src/tuya/capabilities.ts`    | Reads a thing model into measurements and a switch.  |
| `src/matter/bridge.ts`        | Matter server node and aggregator.                   |
| `src/matter/device-endpoint.ts` | Maps a Tuya device onto Matter endpoints.          |

## Tuya cloud

Authenticate as the cloud project with `/v1.0/token?grant_type=1`. The app
account login (`/v1.0/iot-01/associated-users/actions/authorized-login`) is
rejected with `clientId invalid`, and the v1.0 device APIs answer `not support
this device`. Use only these:

- `/v1.0/iot-01/associated-users/devices` — device list, cursor paged with
  `last_row_key`.
- `/v2.0/cloud/thing/{id}/model` — thing model, with the unit and scale of each
  property.
- `/v2.0/cloud/thing/{id}/shadow/properties` — last reported values.
- `/v2.0/cloud/thing/{id}/shadow/properties/issue` — write a property.

Only `openapi.tuyaus.com` answers; the other data centers are suspended for this
project.

A raw value converts as `value / 10 ** scale`, then the unit converts to the
Matter milli-unit. Codes may carry a channel suffix, such as `cur_power1`, so
match the code with the digits stripped. Match codes exactly: `power_coe` is a
calibration coefficient, `switch_inching` configures a momentary switch, and
`add_ele` is the increment since the last report, not a cumulative total.

## Matter

Matter reports electricity in milli-units: mW, mV, mA and mWh.

A device with a writable boolean switch becomes an `OnOffPlugInUnit`, with its
meter as a composed `ElectricalSensor` child endpoint. A device that only meters
becomes a flat bridged `ElectricalSensor`. Both carry
`BridgedDeviceBasicInformation` on the endpoint the aggregator owns.

An on/off command writes to Tuya first and only then updates the Matter
attribute, so the two never disagree after a failure.

## Conventions

- Every setting this project owns is prefixed `TUYA_`. Bare names collide with
  other tools, and a real environment variable silently wins over `.env`.
- `src/page.ts` is a template literal. Escape `` ` `` and `${` when you edit the
  markup, and keep the page dependency free.
- The released binary carries no files beside it, so anything the page needs
  must live in the source.
- Tests use the `node:test` API and run under `bun test`.
- Releases are built by GoReleaser Pro with the Bun builder, for `linux-x64` and
  `linux-arm64`. Its output directory is `dist/`.

## Verifying a change

Type-check and test, then run a throwaway instance with the overrides above and
read `/api/state`. To check a Linux binary, build it and run it under Docker:

```sh
goreleaser build --snapshot --clean
docker run --rm --platform linux/arm64 \
  -v "$PWD/dist/tuya-matter_bun-linux-arm64/tuya-matter:/usr/local/bin/tuya-matter:ro" \
  debian:bookworm-slim tuya-matter
```

To check the page, screenshot it rather than guessing:

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --window-size=900,1200 --virtual-time-budget=4000 \
  --screenshot=/tmp/page.png http://localhost:8099/
```

## Not supported yet

Lights, covers and other controls. Multi-channel devices expose their first
channel only. Updates are polled; the Tuya push stream is unused. The web page
has no authentication.
