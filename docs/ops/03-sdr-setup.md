# RTL-SDR Blog V4 setup

## The gotcha that catches everyone

**The V4 requires the RTL-SDR Blog driver fork.** Stock `librtlsdr` — including the version in
most distro repos — does not recognise the V4's R828D tuner configuration. Symptoms: the device
appears dead, or produces pure noise, or tunes to the wrong frequency.

Do **not** `apt install rtl-sdr` and stop there.

## Install

Remove any stock package and build the fork:

```bash
sudo apt purge -y rtl-sdr librtlsdr0 librtlsdr-dev
sudo apt install -y libusb-1.0-0-dev git cmake pkg-config

git clone https://github.com/rtlsdrblog/rtl-sdr-blog
cd rtl-sdr-blog
mkdir build && cd build
cmake ../ -DINSTALL_UDEV_RULES=ON
make -j$(nproc)
sudo make install
sudo cp ../rtl-sdr.rules /etc/udev/rules.d/
sudo ldconfig
```

## Blacklist the DVB-T driver

The kernel's DVB-T driver claims the device on plug-in:

```bash
echo 'blacklist dvb_usb_rtl28xxu' | sudo tee /etc/modprobe.d/classg-blacklist-rtl.conf
sudo reboot
```

## Verify

```bash
rtl_test -t
```

Expect the R828D tuner to be reported. Then confirm the frequency ceiling for yourself:

```bash
rtl_test -t 2>&1 | grep -i tuner
```

**The tuner tops out at 1.766 GHz.** This is why the SDR cannot see your DJI — see
[ADR-0004](../architecture/adr/0004-rtlsdr-scope.md). Confirming it early prevents a lot of
wasted effort later.

## Gain staging

The 8-bit ADC gives roughly 48 dB of dynamic range, so gain setting matters more than antenna
gain. Start with AGC **off** and set gain manually:

```bash
rtl_test -g 30        # list supported gain values
```

Too much gain overloads the front end and desensitises the receiver — the classic mistake is
maxing gain and wondering why weak signals vanished.

## Bias tee — leave it off

```bash
rtl_biast -b 1        # only for an active antenna / LNA
```

Default is off, and ClassG keeps it that way. Never enable it into a DC-shorted antenna. Note
that the bias tee is the only thing on this device that puts power out of the SMA connector —
it is not a transmitter, and the receive-only property of the project is unaffected.

## ADS-B (first real capability)

```bash
sudo apt install -y dump1090-mutability
dump1090 --interactive --net
```

Web view at `http://<pi>:8080`. Validate against [adsb.lol](https://adsb.lol) or FlightRadar24
for the same aircraft before trusting decodes.

A **filtered 1090 MHz LNA** (~$40) makes the difference between intermittent and reliable
reception. Highest-value SDR accessory for this project.

## Antenna notes by band

| Band | Antenna |
|---|---|
| 1090 MHz ADS-B | 1/4-wave ground plane (~6.9 cm), or a purpose-built collinear |
| 902–928 MHz | 1/4-wave (~8.2 cm), or a 915 MHz whip |
| 433 MHz | 1/4-wave (~16.4 cm) |
| 1.2 GHz FPV | 1/4-wave (~6.2 cm) |

The supplied dipole is adjustable and adequate for bring-up across all of these. **Height and
clear sky view matter far more than antenna gain** — an indoor high-gain antenna loses to an
outdoor whip.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Device not found | DVB-T driver claimed it | Blacklist `dvb_usb_rtl28xxu`, reboot |
| Noise only, wrong frequencies | Stock librtlsdr, not the V4 fork | Rebuild from `rtlsdrblog/rtl-sdr-blog` |
| Permission denied | udev rules not installed | `cmake -DINSTALL_UDEV_RULES=ON`, replug |
| Weak signals disappeared | Gain too high, front-end overload | Reduce gain, disable AGC |
| Drops out under load | USB power/bandwidth contention | Different controller or powered hub |
| Frequency drift when warm | Rare on V4 (1 PPM TCXO) | Check `dmesg` for thermal issues instead |
