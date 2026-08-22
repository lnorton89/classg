# Hardware capability analysis

The purpose of this document is to prevent months of wasted effort. Read it before writing
code against either radio.

## RTL-SDR Blog V4

| Spec | Value | Consequence |
|---|---|---|
| Tuner | Rafael Micro R828D | Triplexed HF/VHF/UHF input |
| Frequency range | 500 kHz – 1.766 GHz | **Hard ceiling. No 2.4 GHz, no 5.8 GHz.** |
| Instantaneous bandwidth | 3.2 MHz theoretical, 2.4 MHz stable | Cannot capture a 10 MHz DroneID burst |
| ADC | 8-bit | ~48 dB dynamic range; strong signals desensitise the front end |
| Reference | 1 PPM TCXO | Good enough for coherent work at these frequencies |

Source: [RTL-SDR Blog V4 datasheet](https://www.rtl-sdr.com/wp-content/uploads/2024/12/RTLSDR_V4_Datasheet_V_1_0.pdf)

### Why it cannot detect your DJI

DJI's OcuSync DroneID transmits on 2.4 GHz and 5.8 GHz. The burst is an LTE-derived OFDM
signal roughly **10 MHz wide** (15.36 MHz including guard carriers), repeating about every
600 ms. Demodulating it requires sampling at 15.36 MSPS — the sample rate must divide evenly
by the 15 kHz LTE subcarrier spacing into a power-of-two FFT, so in practice only 15.36 MSPS
or 30.72 MSPS work.

The RTL-SDR V4 fails this on **two independent counts**:

1. **Frequency.** 2.4 GHz is 640 MHz above the tuner's ceiling.
2. **Bandwidth.** Even downconverted, 2.4 MHz captures 16% of the signal. You cannot
   demodulate OFDM from a fragment of its subcarriers.

Sources: [proto17/dji_droneid](https://github.com/proto17/dji_droneid),
[anarkiwi/samples2djidroneid](https://github.com/anarkiwi/samples2djidroneid),
[Schiller et al., NDSS 2023](https://www.ndss-symposium.org/wp-content/uploads/2023-217-paper.pdf)

**Do not** attempt to work around this with a 2.4 GHz downconverter. A downconverter solves
frequency and leaves bandwidth untouched — you would get an energy detector that says
"something is transmitting in the ISM band," which your microwave oven also triggers. If you
later want real OcuSync decode, the hardware answer is a **HackRF One** (20 MHz), **AntSDR
E200**, **USRP B200**, or **BladeRF** — not an accessory for the RTL.

### What it is genuinely good for

| Target | Frequency | Technique | Value |
|---|---|---|---|
| **ADS-B (1090ES)** | 1090 MHz | Full decode via `dump1090` | Manned-aircraft ground truth. High value: suppresses false positives and gives airspace context. |
| **UAT** | 978 MHz | `dump978` | US general aviation below 18,000 ft |
| **ELRS 900 / Crossfire / RFD900** | 902–928 MHz (US), 868 MHz (EU) | FHSS burst detection, duty-cycle fingerprinting | Detects hobby/FPV/long-range craft that broadcast **no** Remote ID |
| **Legacy telemetry** | 433 MHz ISM | Same | Older MAVLink telemetry links |
| **Analog FPV downlink** | 1.2 / 1.3 GHz (1080–1360 MHz) | Wideband FM energy signature | Long-range analog FPV, often deliberately non-compliant |
| **GNSS L1** | 1575.42 MHz | Noise-floor monitoring | Jamming/interference indicator |

The 900 MHz band is the sleeper feature. Aircraft carrying ELRS or Crossfire are precisely
the ones that will **not** broadcast Remote ID, so the Wi-Fi sensor is blind to them. This is
the SDR's real contribution to drone detection, and it is complementary rather than redundant.

### Practical gotchas

- **The V4 needs the RTL-SDR Blog driver fork.** Stock `librtlsdr` in older distro repos does
  not recognise the V4 and it will appear dead or produce noise. Install from
  `rtlsdrblog/rtl-sdr-blog`. This trips up nearly everyone.
- Blacklist `dvb_usb_rtl28xxu`, or the DVB-T driver claims the device.
- The bias tee is software-controlled — leave it **off** unless feeding an active antenna, and
  never enable it into a DC-shorted antenna.
- 8-bit ADC means gain staging matters more than antenna gain. Start with AGC off and set gain
  manually.

---

## ALFA AWUS036AXML

| Spec | Value |
|---|---|
| Chipset | MediaTek MT7921AU (MT7921AUN) |
| Bands | 2.4 GHz / 5 GHz / 6 GHz (Wi-Fi 6E) |
| Driver | `mt7921u`, in-kernel since Linux **5.18** |
| Firmware | Requires `firmware-misc-nonfree` blobs |
| Bluetooth | BT 5.2 integrated (see caveats) |

Source: [morrownr/USB-WiFi](https://github.com/morrownr/USB-WiFi/discussions/260),
[Rokland AXML Linux support](https://store.rokland.com/pages/alfa-awus036axml-awus036axm-support-linux)

### This is your DJI sensor

Everything ClassG will detect about your test drone arrives through this adapter, as ordinary
802.11 management frames:

- **DJI DroneID** — vendor-specific IE 221, OUI `26:37:12`, carrying serial number, drone
  lat/lon, altitude, velocity, **and the operator's location**.
- **ASTM F3411 Remote ID** — vendor IE 221, OUI `FA:0B:BC`, standards-compliant Basic ID /
  Location / System / Operator ID messages.

Both ride in **beacon frames**, which monitor mode captures passively. No association, no
transmission, no interaction with the drone.

### Landmines — read before plugging in

1. **Never use `active` monitor mode.** Setting active monitor on mt7921u is a known driver
   bug that stops the adapter dead and usually needs a physical replug.
   ([mt76 #839](https://github.com/openwrt/mt76/issues/839), [USB-WiFi #275](https://github.com/morrownr/USB-WiFi/issues/275))
   Use plain passive monitor:
   ```bash
   sudo ip link set wlan-alfa down
   sudo iw dev wlan-alfa set type monitor      # NOT: set monitor active
   sudo ip link set wlan-alfa up
   ```

2. **Bluetooth and Wi-Fi conflict on this device.** On kernels 6.6+, the BT subsystem sharing
   the USB device with `mt7921u` causes sporadic Wi-Fi crashes. Since Wi-Fi is the primary
   mission, disable the adapter's Bluetooth:
   ```bash
   echo 'install btusb /bin/false' | sudo tee /etc/modprobe.d/classg-no-btusb.conf
   ```
   Use a **separate** BLE dongle for Class G detection.

3. **6 GHz is unusable and you don't need it.** The US entry in the kernel regulatory database
   carries a `NO-IR` flag for 6 GHz, which disables passive listening. Drones do not broadcast
   Remote ID on 6 GHz. Ignore the band.

4. **Injection is unreliable.** Irrelevant here — ClassG never transmits — but do not follow
   generic pentest guides that test the adapter via injection and conclude it's broken.

5. **Power draw is significant.** Combined with an RTL-SDR on a Pi 4, USB brownouts are a real
   failure mode that presents as random adapter disappearance. Use a Pi 5 with an adequate PSU,
   or a powered hub.

### The Bluetooth gap

This is the most important **capability shortfall** in the current hardware set.

ASTM F3411 defines four transports. Remote ID broadcasts over Bluetooth 5 Long Range
(LE Coded PHY, S2/S8) achieve 500 m – 1+ km, and many compliant drones and most
retrofit broadcast modules use Bluetooth **exclusively**.

Receiving LE Coded PHY extended advertising requires a controller that supports it. Ordinary
BT adapters — including the MT7921's — generally cannot. The established solution is a
dedicated sniffer:

- **nRF52840 dongle** (~$10–25) or **Sonoff CC2652P** flashed with
  [Sniffle](https://github.com/nccgroup/Sniffle) firmware
- Feeds the same detection bus as every other sensor

Recommendation: **buy one nRF52840 dongle.** It is the highest detection-coverage-per-dollar
addition available, and it closes a gap the Wi-Fi adapter structurally cannot.

---

## Consolidated detection matrix

| Emission | Band | RTL-SDR V4 | AWUS036AXML | nRF52840 (add-on) |
|---|---|---|---|---|
| DJI OcuSync DroneID | 2.4 / 5.8 GHz | ❌ out of band + bandwidth | ❌ not 802.11 | ❌ |
| DJI Wi-Fi DroneID (IE 221) | 2.4 / 5 GHz | ❌ | ✅ **primary** | ❌ |
| F3411 RID — Wi-Fi Beacon | 2.4 / 5 GHz | ❌ | ✅ **primary** | ❌ |
| F3411 RID — Wi-Fi NAN | 2.4 / 5 GHz | ❌ | ⚠️ harder, cluster frames | ❌ |
| F3411 RID — BT4 legacy | 2.4 GHz | ❌ | ⚠️ driver conflict | ✅ |
| F3411 RID — BT5 Coded PHY | 2.4 GHz | ❌ | ❌ | ✅ **only option** |
| Wi-Fi OUI / SSID fingerprint | 2.4 / 5 GHz | ❌ | ✅ | ❌ |
| ELRS 900 / Crossfire / RFD900 | 868 / 915 MHz | ✅ **primary** | ❌ | ❌ |
| ELRS 2.4 / FrSky | 2.4 GHz | ❌ | ⚠️ energy only | ❌ |
| Analog FPV video | 1.2 / 1.3 GHz | ✅ **primary** | ❌ | ❌ |
| Analog FPV video | 5.8 GHz | ❌ | ⚠️ survey scan only | ❌ |
| ADS-B / UAT | 1090 / 978 MHz | ✅ **primary** | ❌ | ❌ |
| GNSS L1 interference | 1575 MHz | ✅ | ❌ | ❌ |

Legend: ✅ decode · ⚠️ detect-only or unreliable · ❌ impossible

## Upgrade paths, ranked by value

1. **nRF52840 + Sniffle** (~$25) — closes the Bluetooth Remote ID gap. Do this first.
2. **Directional 2.4/5 GHz antenna** on the ALFA — turns detection into crude bearing, and
   two fixed sectors give rough azimuth without any extra software complexity.
3. **1090 MHz filtered LNA** (~$40) — makes ADS-B genuinely reliable rather than intermittent.
4. **HackRF One / AntSDR E200** (~$150–400) — the *only* way to reach real OcuSync DroneID
   decode at 2.4/5.8 GHz. Only worth it if decoding DJI's proprietary link is the goal;
   Remote ID over Wi-Fi already gives you serial + position for compliant aircraft.
