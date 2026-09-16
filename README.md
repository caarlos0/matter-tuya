# tuya-matter

Exposes Tuya cloud devices as Matter devices on your local network.

A web page lists every device in your Tuya account. Choose the ones you want,
and the bridge publishes them over Matter:

- A device with a power switch becomes an **On/Off Plug-in Unit**. Its meter, if
  it has one, is a composed **Electrical Sensor** endpoint.
- A device that only meters becomes an **Electrical Sensor**.

Controllers such as Home Assistant then show the switch, active power, voltage,
current and imported energy.

## Install

Download a Linux binary from the [releases page][releases]. It is
self-contained: no runtime, no `node_modules`, no files beside it.

```sh
tar xf tuya-matter_Linux_x86_64.tar.gz
./tuya-matter
```

[releases]: https://github.com/caarlos0/matter-tuya/releases

## Requirements

- A Tuya IoT Platform cloud project with a linked Smart Life / Tuya Smart app
  account.
- [Bun](https://bun.sh) 1.4 or later, to run from source.

## Setup

1. Open [iot.tuya.com](https://iot.tuya.com), go to **Cloud → Development**, and
   create a project in the data center of your app account.
2. In **Devices → Link App Account**, link the app account that owns the meters.
3. In **Service API**, subscribe to **IoT Core** and **Device Status
   Notification**.
4. Copy `.env.example` to `.env` and fill in `TUYA_ACCESS_ID`,
   `TUYA_ACCESS_KEY` and `TUYA_COUNTRY_CODE`.

```sh
bun install
bun start
```

Then open <http://localhost:8080>.

## Using the web page

The page lists every device in the linked Tuya account.

- **Expose** adds the device to the Matter bridge. The controller sees it at
  once; no restart is needed.
- **Remove** takes it off the bridge again.
- A device with neither a switch nor metering cannot be exposed, so its button
  is disabled.
- **Refresh from Tuya** reloads the account. A device you deleted in the Tuya
  app is removed from the bridge too.
- Exposed devices show their switch state and latest reading, refreshed every
  `POLL_INTERVAL` seconds.

The page also shows the pairing code. Use it to commission the bridge in your
Matter controller. The choice of devices is stored, so it survives a restart.

## Configuration

| Variable               | Required | Default              | Meaning                                      |
| ---------------------- | -------- | -------------------- | -------------------------------------------- |
| `TUYA_ACCESS_ID`       | yes      |                      | Cloud project access ID.                     |
| `TUYA_ACCESS_KEY`      | yes      |                      | Cloud project access secret.                 |
| `TUYA_COUNTRY_CODE`    | no       | `1`                  | Phone country code; selects the data center. |
| `TUYA_ENDPOINT`        | no       | from the country     | Overrides the data center URL.               |
| `TUYA_POLL_INTERVAL`   | no       | `30`                 | Seconds between Tuya cloud reads.            |
| `TUYA_WEB_PORT`        | no       | `8080`               | Port of the web page.                        |
| `TUYA_STATE_FILE`      | no       | next to Matter data  | File that stores the exposed devices.        |
| `MATTER_PASSCODE`      | no       | `20202021`           | Commissioning passcode.                      |
| `MATTER_DISCRIMINATOR` | no       | `3840`               | Commissioning discriminator.                 |
| `MATTER_PORT`          | no       | `5540`               | Matter UDP port.                             |

Every setting this bridge owns is prefixed, because bare names such as
`ACCESS_ID` collide with other tools. A real environment variable always wins
over the `.env` file, so an old export can hide the file without a warning.

If login fails with `clientId invalid` or `data center is suspended`, the
project lives in a different data center. Set `TUYA_ENDPOINT` to one of
`openapi.tuyaus.com`, `openapi.tuyaeu.com`, `openapi.tuyain.com` or
`openapi.tuyacn.com`.

## How it works

1. Authenticates as the cloud project (`/v1.0/token?grant_type=1`).
2. Lists the devices of the linked app accounts
   (`/v1.0/iot-01/associated-users/devices`).
3. Reads each thing model (`/v2.0/cloud/thing/{id}/model`) and keeps the
   properties that report power, voltage, current or cumulative energy, plus a
   writable boolean `switch` or `switch_<n>`. The model gives the unit and the
   scale, so values convert into the Matter milli-units (mW, mV, mA, mWh).
4. Polls the property shadow (`/v2.0/cloud/thing/{id}/shadow/properties`) of the
   exposed devices and writes the values into the Matter attributes.
5. Sends a Matter on/off command to
   `/v2.0/cloud/thing/{id}/shadow/properties/issue`. Matter reports the new
   state only after Tuya accepts the command.

Codes such as `add_ele` report the increment since the last report, so they
cannot feed the cumulative Matter attribute and are ignored. `switch_inching`
configures a momentary switch, so it is not treated as one.

## State

The Matter fabric and node state live in `~/.matter/tuya-matter`. The list of
exposed devices is in `~/.matter/tuya-matter-devices.json`.

## Clearing the pairings

Remove the bridge in your controller first. That deletes the fabric on both
sides.

If the controller entry is gone or stuck, factory reset the bridge. Stop it
first: erasing the state under a running bridge leaves the old fabric in memory,
and the pairing code does not come back. `bun run reset` refuses while the
bridge runs.

```sh
bun run reset
bun start
```

The bridge then prints a new pairing code, on the page and in the log. Your
controller keeps a dead entry for the old bridge, so remove it by hand. The list
of exposed devices survives.

## Limits

- Only power switches and electricity metering. Lights, covers and other
  controls are not exposed yet.
- The web page has no authentication. Keep it on a trusted network.
- One endpoint per device. Multi-channel meters and multi-gang switches expose
  their first channel only.
- Polling only. The Tuya push (Pulsar) stream is not used.

## Development

```sh
bun start          # run from source
bun test src       # run the tests
bun run typecheck  # tsc --noEmit
bun run build      # compile a binary for this machine
```

Releases are built by [GoReleaser](https://goreleaser.com) with the Bun builder,
which runs `bun build --compile` for `linux-x64` and `linux-arm64`. Push a tag
to release:

```sh
git tag -a v0.1.0 -m v0.1.0
git push origin v0.1.0
```

The web page is inlined in `src/page.ts` so the binary stays a single file.
Edit it there.
