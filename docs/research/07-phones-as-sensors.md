# Phones as supplemental sensors

**Short answer: a PWA cannot be a drone sensor, and no amount of engineering
makes it one.** It can contribute *position*, which is genuinely useful and
worth building. Anything more needs a native Android app.

This records why, so the question does not get re-opened by someone who assumes
the browser must be able to do it somehow.

## What the browser cannot do

### Wi-Fi: nothing at all

There is **no web API for Wi-Fi** in any browser — not scanning, not monitor
mode, not raw frames, not even a list of visible SSIDs. This is not a
permissions problem or a flag; the capability does not exist in the platform.

That is decisive here, because **Wi-Fi is where DJI lives**. DroneID and
Wi-Fi-based Remote ID are exactly what `sensor-wifi` exists to capture, and a
phone browser cannot see any of it. A phone running the PWA is as blind to a
DJI as the RTL-SDR is, for a different reason and just as permanently.

### Bluetooth: technically specified, practically unavailable

Remote ID also broadcasts over BLE advertisements (ASTM F3411), and the Web
Bluetooth `requestLEScan()` API is designed for exactly this — passive
observation of nearby advertisements. It is the one path that is not obviously
impossible.

It is still unavailable in practice:

| | Status |
|---|---|
| Safari / iOS / iPadOS | **Web Bluetooth is not implemented at all.** Not behind a flag — absent. |
| Firefox | Not implemented. |
| Chrome / Chromium | Implemented, but `requestLEScan()` is **behind `chrome://flags/#enable-experimental-web-platform-features`**. |

So the best case is: an Android phone, running Chrome, with an experimental flag
manually enabled, with the tab in the foreground. That is not a sensor. It is a
demo that stops working when the screen locks, and it excludes every iPhone
outright.

`watchAdvertisements()` has the same flag requirement, and `requestDevice()` —
which *is* generally available — is useless here: it requires a user gesture and
a chooser dialog per device, which is the opposite of passive observation.

### Everything else

No cellular radio access, no raw sockets, no promiscuous anything. A browser is
deliberately not able to observe the RF environment, and that is a correct
design decision on the platform's part.

## What the browser can do, usefully

**Geolocation.** `navigator.geolocation.watchPosition()` gives GPS with accuracy
metadata, on every platform, with a normal permission prompt. That is real and
worth having.

A phone on the tailnet reporting its position lets ClassG answer questions it
currently cannot:

- **Where is the operator right now**, as distinct from where the receiver is.
  The map centres on a configured receiver position; a person walking a
  perimeter is somewhere else.
- **How far is that detection from me**, rather than from the box.
- **A moving receiver.** If the Pi is in a vehicle, its position is not the
  static value in `map.receiver_position`.

This is a *position source*, not a detection source, and calling it a "sensor"
would overstate it. It contributes geometry.

**Alerting.** The PWA already receives detections over the websocket and can
raise notifications. Combined with the hook system, a phone is a perfectly good
alerting endpoint — it just is not an observing one.

## What would actually work: a native Android app

BLE Remote ID reception from a phone is a solved problem *outside* the browser.
Android grants `BLUETOOTH_SCAN` to an app and passive advertisement scanning
works, in the background, without flags. Several open-source Remote ID receivers
already do this.

The cost is a second codebase, a second release process, and a Play Store
listing or sideloading — which is why this is written down rather than started.
It would be worth it only if BLE Remote ID coverage matters more than the
effort, and today `sensor-wifi` already covers the Remote ID traffic that
matters most around here.

**An iPhone cannot do this either way.** iOS gives no app passive access to
arbitrary BLE advertisements in the background in a way that suits this.

## Recommendation

1. **Build phone position reporting.** Small, useful, works everywhere, and
   needs nothing but geolocation and a tailnet route to the API. A phone becomes
   a mobile position source and an alerting endpoint.
2. **Do not build BLE scanning into the PWA.** Chromium-only, flag-gated,
   foreground-only. It would look like a feature and behave like a bug report
   generator.
3. **Leave the native app as an open option**, revisited if BLE Remote ID
   coverage becomes the gap that matters.

Whatever gets built, the receive-only constraint applies unchanged: a phone
observes and reports, and never transmits at a drone
([06-legal-and-ethics.md](06-legal-and-ethics.md)).

## Sources

- [Web Bluetooth implementation status](https://github.com/WebBluetoothCG/web-bluetooth/blob/main/implementation-status.md)
- [Communicating with Bluetooth devices over JavaScript — Chrome for Developers](https://developer.chrome.com/docs/capabilities/bluetooth)
- [Web Bluetooth requestLEScan — Chrome Platform Status](https://chromestatus.com/feature/5346724402954240)
- [Web Bluetooth API — MDN](https://developer.mozilla.org/en-US/docs/Web/API/Web_Bluetooth_API)
