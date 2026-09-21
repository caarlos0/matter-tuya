# tuya-matter

Exposes Tuya devices as Matter devices, reading and controlling them on your
own network.

A web page lists every device in your Tuya account. Choose the ones you want,
and the bridge publishes them over Matter:

- A device with a power switch becomes an **On/Off Plug-in Unit**. Its meter, if
  it has one, is a composed **Electrical Sensor** endpoint.
- A device that only meters becomes an **Electrical Sensor**.

Controllers such as Home Assistant then show the switch, active power, voltage,
current and imported energy.

Every reading and every command goes straight to the device on your network.
The Tuya cloud is asked once, for the local keys, and never again.

## Install

Get a `.deb` or a tarball from the [releases page][releases], for `x86_64` or
`arm64`. The binary is self-contained: no runtime, no `node_modules`, no files
beside it.

```sh
sudo dpkg -i tuya-matter_0.1.0_linux_amd64.deb
tuya-matter
```

```sh
tar xf tuya-matter_Linux_x86_64.tar.gz
./tuya-matter
```

[releases]: https://github.com/caarlos0/matter-tuya/releases

## Requirements

- The devices and the bridge on the same routable network.
- A Tuya IoT Platform cloud project with a linked Smart Life / Tuya Smart app
  account, to enrol the devices once.
- [Bun](https://bun.sh) 1.4 or later, to run from source.

## Setup

1. Open [iot.tuya.com](https://iot.tuya.com), go to **Cloud → Development**, and
   create a project in the data center of your app account.
2. In **Devices → Link App Account**, link the app account that owns the meters.
3. In **Service API**, subscribe to **IoT Core** and **Device Status
   Notification**.
4. Copy `.env.example` to `.env`. Set `TUYA_SUBNET` to the subnet the devices
   live on, and fill in `TUYA_ACCESS_ID`, `TUYA_ACCESS_KEY` and
   `TUYA_COUNTRY_CODE`.

```sh
bun install
bun start
```

Then open <http://localhost:8080>.

The first run asks the cloud for the local key and the data point map of each
device, and stores them. After that you can remove the credentials: the bridge
never asks again.

## Using the web page

The page lists every device in the linked Tuya account.

- **Expose** adds the device to the Matter bridge and tells the controllers the
  bridge changed, so the device appears without a restart.
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
| `TUYA_SUBNET`          | yes      |                      | Subnet the devices live on, e.g. `10.0.0.0/24`. |
| `TUYA_ACCESS_ID`       | once     |                      | Cloud project access ID, to enrol devices.   |
| `TUYA_ACCESS_KEY`      | once     |                      | Cloud project access secret.                 |
| `TUYA_COUNTRY_CODE`    | no       | `1`                  | Phone country code; selects the data center. |
| `TUYA_ENDPOINT`        | no       | from the country     | Overrides the data center URL.               |
| `TUYA_POLL_INTERVAL`   | no       | `30`                 | Seconds between readings.                    |
| `TUYA_WEB_PORT`        | no       | `8080`               | Port of the web page.                        |
| `TUYA_STATE_FILE`      | no       | next to Matter data  | File that stores the exposed devices.        |
| `TUYA_ENROLLMENT_FILE` | no       | next to Matter data  | File that stores the local keys.             |
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

Once, to enrol:

1. Authenticates as the cloud project (`/v1.0/token?grant_type=1`) and lists the
   devices of the linked app accounts, which carry the local key each device
   demands.
2. Reads each thing model (`/v2.0/cloud/thing/{id}/model`), which names every
   data point and gives its unit and scale.
3. Stores both. Neither changes while a device stays paired.

Then, on your own network only:

4. Searches `TUYA_SUBNET` for port 6668 and proves which device is at each
   address by completing a handshake, which only the device holding the key
   can do. Addresses are remembered, so a restart is quick, but never trusted.
5. Reads the data points of the exposed devices and converts them into the
   Matter milli-units (mW, mV, mA, mWh).
6. Sends a Matter on/off command to the device. Matter reports the new state
   only after the device accepts the command.

Codes such as `add_ele` report the increment since the last report, so they
cannot feed the cumulative Matter attribute and are ignored. `switch_inching`
configures a momentary switch, so it is not treated as one.

A local key cannot be worked out from a device, and the data point map is
published nowhere else, which is why the cloud is asked at all. Re-pair a
device and its key changes: delete the enrolment file to ask again.

## State

The Matter fabric and node state live in `~/.matter/tuya-matter`. Beside it,
`tuya-matter-devices.json` lists the exposed devices, `tuya-matter-enrollment.json`
holds the local keys, and `tuya-matter-addresses.json` remembers where each
device last answered.

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
- Polling only. The devices are read on a timer, not pushed.
- Broadcast discovery is not used, because it does not cross a VLAN. The subnet
  is searched instead, so the bridge only needs to be able to route to it.

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
