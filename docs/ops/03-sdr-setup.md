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
sudo usermod -aG plugdev dump1090      # see below -- it will not work without this
sudo systemctl restart dump1090-mutability
```

The Debian package installs a service that starts on boot and owns the radio;
there is no bare `dump1090` binary to run by hand, and starting a second one
would only fight the first for the device.

**It runs as its own `dump1090` user, which is not in `plugdev`.** The rtl-sdr
udev rule grants `MODE="0660" GROUP="plugdev"`, so out of the box the service
starts, reports `usb_open error -3`, and then sits there *running perfectly
happily with no radio at all* — `systemctl is-active` says `active` and nothing
else complains. Add the user to the group; do not widen the udev rule to 0666,
which hands the radio to every local user on the box.

Web view at `http://<pi>/dump1090`, served through lighttpd. **Not port 8080** —
that is the ClassG UI, and following an 8080 link here shows you the wrong
application entirely. The JSON underneath is what to check:

```bash
curl -s http://127.0.0.1/dump1090/data/aircraft.json    # what it can see now
curl -s http://127.0.0.1/dump1090/data/stats.json       # how well it hears
```

In `stats.json`, `local.accepted` is what the antenna heard and
`remote.accepted` is anything fed in over the network — keep them apart when
judging reception.

**Reception is bursty, so do not diagnose it from one short window.** Six
minutes can pass with `peak_signal` equal to `noise`, zero aircraft, and no SBS
output at all, and look exactly like a dead antenna; then an aircraft crosses
and 120 messages arrive at once. If you want to know whether the antenna is
connected at all, sweep the FM broadcast band instead — it is strong
everywhere, and `rtl_power -f 88M:108M:100k -g 30 -i 8 -1 fm.csv` will show
tens of dB between floor and peaks if the feedline is good.

Validate against [adsb.lol](https://adsb.lol) or FlightRadar24 for the same
aircraft before trusting decodes.

### Replaying a capture instead of waiting for an aircraft

dump1090 accepts raw AVR frames on port 30001 and emits SBS-1 on 30003, so a
saved capture exercises the whole decode path with no radio and no traffic:

```bash
nc 127.0.0.1 30003 > /tmp/sbs.txt &          # listen for decoded output
nc 127.0.0.1 30001 < captures/<file>-avr.txt # feed the frames in
```

Expect far fewer SBS lines than input frames — most raw frames fail CRC, which
is the filter doing its job.

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
