# AGENTS.md

Bridge that exposes Tuya devices as Matter devices. Every reading and every
command goes to the device on the local network. A web page lists the account
and the user picks which devices to expose.

## Safety

The Tuya devices are real appliances in a home, and some of them are water
heaters. **Never send an on/off command to a real device without explicit
permission for that device.** To exercise the write path safely, read the
current value and write the same value back.

The bridge locks its Matter storage. Always override it when you run a test
instance, or you take over the paired production node:

```sh
TUYA_WEB_PORT=8099 MATTER_PORT=5599 MATTER_STORAGE_PATH=/tmp/tm-test \
  TUYA_STATE_FILE=/tmp/tm-test/devices.json \
  TUYA_ENROLLMENT_FILE=/tmp/tm-test/enrollment.json \
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
| `src/addresses.ts`            | Remembers where each device last answered.           |
| `src/tuya/api.ts`             | Tuya cloud client. Enrolment only; it cannot read or write a device. |
| `src/tuya/enrollment.ts`      | Asks the cloud once for keys and thing models, and stores them. |
| `src/tuya/discovery.ts`       | Searches the subnet and proves which device is where. |
| `src/tuya/protocol.ts`        | The Tuya wire protocol on port 6668.                 |
| `src/tuya/local.ts`           | Reads and writes devices on the local network.       |
| `src/tuya/capabilities.ts`    | Reads a thing model into measurements and a switch.  |
| `src/matter/bridge.ts`        | Matter server node and aggregator.                   |
| `src/matter/device-endpoint.ts` | Maps a Tuya device onto Matter endpoints.          |

## Tuya cloud

The cloud is asked once, to enrol. It can neither read nor write device state,
and those calls are absent from the client on purpose.

Authenticate as the cloud project with `/v1.0/token?grant_type=1`. The app
account login (`/v1.0/iot-01/associated-users/actions/authorized-login`) is
rejected with `clientId invalid`, and the v1.0 device APIs answer `not support
this device`. Use only these:

- `/v1.0/iot-01/associated-users/devices` — device list, cursor paged with
  `last_row_key`. Each entry carries `local_key`.
- `/v2.0/cloud/thing/{id}/model` — thing model. `abilityId` is the data point
  number, and the unit and scale of each property are here.

Only `openapi.tuyaus.com` answers; the other data centers are suspended for this
project.

A local key cannot be derived, and the data point map is published nowhere
else. That is the whole reason the cloud is needed. A key changes only when a
device is re-paired.

## Tuya on the local network

Devices listen on TCP 6668. The wire format follows tinytuya.

- Versions differ per device. This house has 3.4 and 3.5 on the same subnet,
  so detect, never assume.
- 3.5 frames with `0x6699` and AES-128-GCM. The older versions frame with
  `0x55AA` and AES-128-ECB. 3.4 and 3.5 negotiate a session key first.
- A request and a response are not the same shape. Only a response carries a
  4 byte return code before the body.
- **Every command except a plain read needs a 15 byte version header**: the
  version string then twelve zero bytes. Without it a write is answered
  `data format error` and nothing happens.
- A write is `CONTROL_NEW` (`0x0d`) on 3.4 and 3.5, `CONTROL` (`0x07`) below.
  The payload is `{"protocol":5,"t":<int>,"data":{"dps":{...}}}`. A 3.4 device
  acknowledges with an empty frame, a 3.5 device with a status push.
- A wrong key is not refused, it is ignored: the frame is dropped and the
  guess costs the whole timeout. So the version cannot be probed without the
  right key, and searching is done in parallel, one version at a time across
  every address.

Broadcast discovery on UDP 6666/6667 does not cross a VLAN, and IoT devices
usually sit on one of their own, so the subnet is searched over TCP instead.

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
- The cloud client must stay unable to read or write a device. Keeping those
  calls absent is what stops a reading ever depending on the cloud.
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
channel only. Updates are polled. The web page has no authentication.
