# tuya-matter

Exposes Tuya cloud devices as Matter devices on your local network.

A web page lists every device in your Tuya account. Choose the ones you want,
and the bridge publishes each as a Matter **Electrical Sensor** endpoint.
Controllers such as Home Assistant then show active power, voltage, current and
imported energy.

## Requirements

- Node.js 22 or later.
- A Tuya IoT Platform cloud project with a linked Smart Life / Tuya Smart app
  account.

## Setup

1. Open [iot.tuya.com](https://iot.tuya.com), go to **Cloud → Development**, and
   create a project in the data center of your app account.
2. In **Devices → Link App Account**, link the app account that owns the meters.
3. In **Service API**, subscribe to **IoT Core** and **Device Status
   Notification**.
4. Copy `.env.example` to `.env` and fill in `ACCESS_ID`, `ACCESS_KEY` and
   `COUNTRY_CODE`.

```sh
npm install
npm run build
npm start
```

Then open <http://localhost:8080>.

## Using the web page

The page lists every device in the linked Tuya account.

- **Expose** adds the device to the Matter bridge. The controller sees it at
  once; no restart is needed.
- **Remove** takes it off the bridge again.
- Devices without electricity metering cannot be exposed, so their button is
  disabled.
- **Refresh from Tuya** reloads the account. A device you deleted in the Tuya
  app is removed from the bridge too.
- Exposed devices show their latest reading, refreshed every `POLL_INTERVAL`
  seconds.

The page also shows the pairing code. Use it to commission the bridge in your
Matter controller. The choice of devices is stored, so it survives a restart.

## Configuration

| Variable               | Required | Default             | Meaning                                       |
| ---------------------- | -------- | ------------------- | --------------------------------------------- |
| `ACCESS_ID`            | yes      |                     | Cloud project access ID.                      |
| `ACCESS_KEY`           | yes      |                     | Cloud project access secret.                  |
| `COUNTRY_CODE`         | no       | `1`                 | Phone country code; selects the data center.  |
| `TUYA_ENDPOINT`        | no       | from `COUNTRY_CODE` | Overrides the data center URL.                |
| `POLL_INTERVAL`        | no       | `30`                | Seconds between Tuya cloud reads.             |
| `WEB_PORT`             | no       | `8080`              | Port of the web page.                         |
| `STATE_FILE`           | no       | next to Matter data | File that stores the exposed devices.         |
| `MATTER_PASSCODE`      | no       | `20202021`          | Commissioning passcode.                       |
| `MATTER_DISCRIMINATOR` | no       | `3840`              | Commissioning discriminator.                  |
| `MATTER_PORT`          | no       | `5540`              | Matter UDP port.                              |

If login fails with `clientId invalid` or `data center is suspended`, the
project lives in a different data center. Set `TUYA_ENDPOINT` to one of
`openapi.tuyaus.com`, `openapi.tuyaeu.com`, `openapi.tuyain.com` or
`openapi.tuyacn.com`.

## How it works

1. Authenticates as the cloud project (`/v1.0/token?grant_type=1`).
2. Lists the devices of the linked app accounts
   (`/v1.0/iot-01/associated-users/devices`).
3. Reads each thing model (`/v2.0/cloud/thing/{id}/model`) and keeps the
   properties that report power, voltage, current or cumulative energy. The
   model gives the unit and the scale, so values convert into the Matter
   milli-units (mW, mV, mA, mWh).
4. Polls the property shadow (`/v2.0/cloud/thing/{id}/shadow/properties`) of the
   exposed devices and writes the values into the Matter attributes.

A device with neither power nor energy cannot be exposed. Codes such as
`add_ele` report the increment since the last report, so they cannot feed the
cumulative Matter attribute and are ignored.

## State

The Matter fabric and node state live in `~/.matter/tuya-matter`. Delete that
directory to factory reset the bridge. The list of exposed devices is in
`~/.matter/tuya-matter-devices.json`.

## Limits

- Read-only. Switches and other controls are not exposed yet.
- The web page has no authentication. Keep it on a trusted network.
- One endpoint per device. Multi-channel meters report their first channel only.
- Polling only. The Tuya push (Pulsar) stream is not used.
