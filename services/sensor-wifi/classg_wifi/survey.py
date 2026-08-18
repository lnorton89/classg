"""Per-channel occupancy from the driver's own survey counters.

Why this exists: the RTL-SDR tunes 500 kHz - 1.766 GHz, so the spectrum view has
nothing whatsoever to say about 2.4 and 5 GHz -- which is where every DJI drone
talks (ADR-0004). The Wi-Fi adapter cannot produce an FFT and this is not one.
What it can do is read the counters mac80211 already keeps for its own channel
selection: how long the radio sat on a frequency, how much of that time the
medium was busy, and the noise floor the driver measured there.

That answers the question an operator opens a spectrum page to ask -- how loud
is this channel, and is it getting louder -- for the two bands the SDR is deaf
to. It is occupancy, not identification: a busy channel is a busy channel,
whether the energy is a drone, a neighbour's access point or a microwave oven.

Receive-only, and passive even by this project's standards: `iw survey dump`
reads counters the driver keeps anyway. It tunes nothing, transmits nothing, and
does not interrupt the capture loop.

Absence is normal. `iw` may not be installed, the driver may report no survey at
all (a non-mac80211 device), and a monitor-mode interface reports counters only
for channels it has actually visited. None of that makes the sensor unhealthy,
so every failure here degrades to "no survey" rather than raising.
"""

from __future__ import annotations

import logging
import shutil
import subprocess
from dataclasses import dataclass, field
from typing import Any

log = logging.getLogger(__name__)

# `iw survey dump` on a wedged adapter can block on netlink. This is one
# subprocess between two dwells, so it is bounded hard and skipped on timeout.
SURVEY_TIMEOUT_S = 2.0

def channel_for(freq_mhz: int) -> int | None:
    """802.11 channel number for a centre frequency, or None off-plan."""
    if freq_mhz == 2484:  # channel 14, Japan only, and not 2407-based
        return 14
    if 2412 <= freq_mhz <= 2472:
        return (freq_mhz - 2407) // 5
    if 5160 <= freq_mhz <= 5885:
        return (freq_mhz - 5000) // 5
    if 5955 <= freq_mhz <= 7115:  # 6 GHz. The hopper never goes there (NO-IR), but
        # a driver that surveys it anyway should still be labelled correctly.
        return (freq_mhz - 5950) // 5
    return None


def band_for(freq_mhz: int) -> str:
    if freq_mhz < 3000:
        return "2.4"
    if freq_mhz < 5925:
        return "5"
    return "6"


@dataclass(slots=True)
class ChannelSurvey:
    """One frequency's counters, as read. All times are milliseconds."""

    freq_mhz: int
    in_use: bool = False
    noise_dbm: float | None = None
    active_ms: float = 0.0
    busy_ms: float = 0.0
    rx_ms: float = 0.0
    tx_ms: float = 0.0


def parse_survey(text: str) -> list[ChannelSurvey]:
    """Parse `iw dev IFACE survey dump` output.

    The format is stable across iw versions in the fields used here, but the set
    of fields is not: a driver may report a frequency with a noise figure and no
    time counters at all. Everything is therefore optional, and a block that
    carries only a frequency is still returned -- "this channel exists and told
    us nothing" is a different statement from "this channel is quiet".
    """
    out: list[ChannelSurvey] = []
    current: ChannelSurvey | None = None

    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("Survey data from"):
            continue
        if line.startswith("frequency:"):
            if current is not None:
                out.append(current)
            value = line.split(":", 1)[1].strip()
            in_use = "[in use]" in value
            digits = value.split()[0]
            try:
                current = ChannelSurvey(freq_mhz=int(digits), in_use=in_use)
            except ValueError:
                current = None
            continue
        if current is None:
            continue

        key, _, value = line.partition(":")
        number = value.strip().split(" ")[0]
        try:
            parsed = float(number)
        except ValueError:
            continue

        key = key.strip()
        if key == "noise":
            current.noise_dbm = parsed
        elif key == "channel active time":
            current.active_ms = parsed
        elif key == "channel busy time":
            current.busy_ms = parsed
        elif key == "channel receive time":
            current.rx_ms = parsed
        elif key == "channel transmit time":
            current.tx_ms = parsed

    if current is not None:
        out.append(current)
    return out


def read_survey(iface: str, runner: Any = None) -> list[ChannelSurvey]:
    """Run `iw dev IFACE survey dump`, or return [] if that is not possible."""
    run = runner or _run_iw
    text = run(iface)
    if not text:
        return []
    try:
        return parse_survey(text)
    except Exception:  # a parse fault must not stop the capture loop
        log.debug("could not parse survey output", exc_info=True)
        return []


def _run_iw(iface: str) -> str:
    if shutil.which("iw") is None:
        return ""
    try:
        proc = subprocess.run(  # fixed argv, no shell
            ["iw", "dev", iface, "survey", "dump"],
            capture_output=True,
            text=True,
            timeout=SURVEY_TIMEOUT_S,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    if proc.returncode != 0:
        return ""
    return proc.stdout


@dataclass
class SurveySampler:
    """Turns cumulative counters into per-window occupancy.

    The counters `iw` reports are cumulative since the interface came up, so the
    raw busy time of a channel visited for eight hours says nothing about now.
    Each reading is therefore the difference against the previous one, which
    makes the reported window "since the last sample" rather than "since boot".

    A counter that moves backwards means the driver reset it -- an interface
    bounce, a firmware reload. That sample is dropped rather than reported as a
    negative or an absurd positive, and the next one measures from the new base.
    """

    iface: str
    runner: Any = None
    _previous: dict[int, ChannelSurvey] = field(default_factory=dict)
    _available: bool | None = None

    @property
    def available(self) -> bool | None:
        """True once a survey has been read, False once one has failed.

        None before the first attempt. Callers use this to say "no survey on
        this adapter" without implying the sensor is unwell.
        """
        return self._available

    def sample(self) -> list[dict[str, Any]]:
        """Read the counters and return one entry per channel, newest window.

        Called once per heartbeat. That interval is what each reading's window
        describes, which is why there is no separate timer in here.

        Returns [] when there is nothing to report, which includes the first
        reading: with no previous sample there is no window to difference
        against, and reporting cumulative counters once would put a spike on
        every restart.
        """
        readings = read_survey(self.iface, self.runner)
        self._available = bool(readings)
        if not readings:
            self._previous = {}
            return []

        out: list[dict[str, Any]] = []
        for reading in readings:
            previous = self._previous.get(reading.freq_mhz)
            self._previous[reading.freq_mhz] = reading
            if previous is None:
                continue

            active = reading.active_ms - previous.active_ms
            busy = reading.busy_ms - previous.busy_ms
            rx = reading.rx_ms - previous.rx_ms
            tx = reading.tx_ms - previous.tx_ms
            if active < 0 or busy < 0:
                continue
            # A channel the hopper did not visit in this window has an active
            # time of zero. That is not "0% busy" -- nothing was measured -- so
            # it is left out rather than drawn as a quiet channel.
            if active <= 0:
                continue

            entry: dict[str, Any] = {
                "freq_mhz": reading.freq_mhz,
                "band": band_for(reading.freq_mhz),
                "in_use": reading.in_use,
                "active_ms": round(active, 1),
                "busy_ms": round(busy, 1),
                "busy_fraction": round(min(busy / active, 1.0), 4),
                "rx_ms": round(rx, 1),
                "tx_ms": round(max(tx, 0.0), 1),
            }
            channel = channel_for(reading.freq_mhz)
            if channel is not None:
                entry["channel"] = channel
            if reading.noise_dbm is not None:
                entry["noise_dbm"] = reading.noise_dbm
            out.append(entry)

        out.sort(key=lambda e: e["freq_mhz"])
        return out
