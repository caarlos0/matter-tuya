# tuya-matter

Exposes Tuya cloud devices as Matter devices on your local network.

The bridge reads the Tuya cloud and publishes one Matter **Electrical Sensor**
endpoint per Tuya device that measures electricity. Controllers such as Home
Assistant then show active power, voltage, current and imported energy.

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

The first run prints a pairing code and a QR code. Use them to commission the
bridge in your Matter controller.

## Configuration

| Variable               | Required | Default             | Meaning                                       |
| ---------------------- | -------- | ------------------- | --------------------------------------------- |
| `ACCESS_ID`            | yes      |                     | Cloud project access ID.                      |
| `ACCESS_KEY`           | yes      |                     | Cloud project access secret.                  |
| `COUNTRY_CODE`         | no       | `1`                 | Phone country code; selects the data center.  |
| `TUYA_ENDPOINT`        | no       | from `COUNTRY_CODE` | Overrides the data center URL.                |
| `POLL_INTERVAL`        | no       | `30`                | Seconds between Tuya cloud reads.             |
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
4. Polls the property shadow (`/v2.0/cloud/thing/{id}/shadow/properties`) and
   writes the values into the Matter attributes.

Devices without power or energy are skipped. Codes such as `add_ele` report the
increment since the last report, so they cannot feed the cumulative Matter
attribute and are ignored.

## State

The Matter fabric and node state live in `~/.matter/tuya-matter`. Delete that
directory to factory reset the bridge.

## Limits

- Read-only. Switches and other controls are not exposed yet.
- One endpoint per device. Multi-channel meters report their first channel only.
- Polling only. The Tuya push (Pulsar) stream is not used.
