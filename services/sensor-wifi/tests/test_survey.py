from __future__ import annotations

from classg_wifi.survey import (
    SurveySampler,
    band_for,
    channel_for,
    parse_survey,
    read_survey,
)

# Captured from `iw dev wlan1 survey dump` on a mt7921u in monitor mode. The
# shape matters more than the numbers: a frequency block, some with counters and
# some without, and exactly one marked [in use].
IW_OUTPUT = """Survey data from wlan1
\tfrequency:\t\t\t2412 MHz
\tnoise:\t\t\t\t-95 dBm
\tchannel active time:\t\t8000 ms
\tchannel busy time:\t\t1600 ms
\tchannel receive time:\t\t900 ms
\tchannel transmit time:\t\t0 ms
Survey data from wlan1
\tfrequency:\t\t\t2437 MHz [in use]
\tnoise:\t\t\t\t-92 dBm
\tchannel active time:\t\t20000 ms
\tchannel busy time:\t\t12000 ms
\tchannel receive time:\t\t7000 ms
\tchannel transmit time:\t\t0 ms
Survey data from wlan1
\tfrequency:\t\t\t5180 MHz
"""


def test_parses_every_block_including_one_with_no_counters() -> None:
    surveys = parse_survey(IW_OUTPUT)

    assert [s.freq_mhz for s in surveys] == [2412, 2437, 5180]
    assert surveys[0].noise_dbm == -95
    assert surveys[0].busy_ms == 1600
    assert surveys[1].in_use is True
    assert surveys[0].in_use is False
    # The bare block is kept: "this channel exists and reported nothing" is not
    # the same statement as "this channel was quiet".
    assert surveys[2].noise_dbm is None
    assert surveys[2].active_ms == 0


def test_unparseable_output_is_empty_rather_than_an_error() -> None:
    assert parse_survey("") == []
    assert parse_survey("command failed: No such device (-19)") == []
    assert read_survey("wlan1", runner=lambda _iface: "") == []


class FakeRunner:
    """Serves canned `iw` output, one call at a time."""

    def __init__(self, *outputs: str) -> None:
        self.outputs = list(outputs)
        self.calls = 0

    def __call__(self, iface: str) -> str:
        self.calls += 1
        return self.outputs.pop(0) if self.outputs else ""


def dump(active: int, busy: int, rx: int = 0, freq: int = 2437) -> str:
    return (
        f"Survey data from wlan1\n"
        f"\tfrequency:\t{freq} MHz [in use]\n"
        f"\tnoise:\t-92 dBm\n"
        f"\tchannel active time:\t{active} ms\n"
        f"\tchannel busy time:\t{busy} ms\n"
        f"\tchannel receive time:\t{rx} ms\n"
        f"\tchannel transmit time:\t0 ms\n"
    )


def test_first_sample_reports_nothing() -> None:
    # The counters are cumulative since the interface came up. Reporting the
    # first reading as-is would draw eight hours of accumulated busy time as a
    # spike on every sensor restart.
    sampler = SurveySampler(iface="wlan1", runner=FakeRunner(dump(10_000, 4_000)))

    assert sampler.sample() == []
    assert sampler.available is True


def test_second_sample_is_the_window_since_the_first() -> None:
    sampler = SurveySampler(
        iface="wlan1",
        runner=FakeRunner(dump(10_000, 4_000), dump(11_000, 4_500, rx=200)),
    )

    sampler.sample()
    [entry] = sampler.sample()

    assert entry["active_ms"] == 1000
    assert entry["busy_ms"] == 500
    assert entry["busy_fraction"] == 0.5
    assert entry["rx_ms"] == 200
    assert entry["channel"] == 6
    assert entry["band"] == "2.4"
    assert entry["noise_dbm"] == -92
    assert entry["in_use"] is True


def test_a_counter_reset_is_dropped_rather_than_reported() -> None:
    # An interface bounce or firmware reload restarts the counters. The
    # difference goes negative, and the honest reading of a negative busy time
    # is "no measurement", not a number.
    sampler = SurveySampler(
        iface="wlan1", runner=FakeRunner(dump(10_000, 4_000), dump(200, 50))
    )

    sampler.sample()
    assert sampler.sample() == []

    # And the next window measures from the new base rather than staying stuck.
    sampler.runner = FakeRunner(dump(1_200, 300))
    [entry] = sampler.sample()
    assert entry["active_ms"] == 1000
    assert entry["busy_ms"] == 250


def test_a_channel_the_hopper_did_not_visit_is_omitted_not_drawn_as_quiet() -> None:
    sampler = SurveySampler(
        iface="wlan1",
        runner=FakeRunner(
            dump(10_000, 4_000) + dump(5_000, 100, freq=5180),
            dump(11_000, 4_500) + dump(5_000, 100, freq=5180),
        ),
    )

    sampler.sample()
    entries = sampler.sample()

    # 5180 was surveyed but not revisited: zero active time in this window is an
    # absence of measurement, and drawing it at 0% busy would claim a quiet
    # channel the radio never listened to.
    assert [e["freq_mhz"] for e in entries] == [2437]


def test_busy_fraction_cannot_exceed_one() -> None:
    # Drivers have been seen reporting busy time slightly above active time.
    sampler = SurveySampler(
        iface="wlan1", runner=FakeRunner(dump(1_000, 500), dump(2_000, 1_600))
    )

    sampler.sample()
    [entry] = sampler.sample()
    assert entry["busy_fraction"] == 1.0


def test_no_iw_is_unavailable_rather_than_an_error() -> None:
    sampler = SurveySampler(iface="wlan1", runner=lambda _iface: "")

    assert sampler.sample() == []
    assert sampler.available is False


def test_channel_and_band_mapping() -> None:
    assert channel_for(2412) == 1
    assert channel_for(2437) == 6
    assert channel_for(2472) == 13
    assert channel_for(2484) == 14  # not 2407-based, which is why it is special
    assert channel_for(5180) == 36
    assert channel_for(5745) == 149
    assert channel_for(1090) is None

    assert band_for(2437) == "2.4"
    assert band_for(5180) == "5"
    assert band_for(5955) == "6"


# Measured on the unit's mt7921u in monitor mode, 2026-08-18. `iw survey dump`
# returns exactly ONE entry, for 5955 MHz -- a 6 GHz channel the hopper never
# tunes and the US regdomain forbids -- whose active time advances at wall-clock
# rate with busy, receive and noise all absent. The channels actually being
# swept do not appear at all.
MT7921U_MONITOR_MODE = """Survey data from wlan1
\tfrequency:\t\t\t5955 MHz
\tchannel active time:\t\t{active} ms
"""


def test_an_entry_with_no_busy_and_no_noise_is_not_a_measurement() -> None:
    # Active time alone says the radio existed for a while. Rendering that as
    # "0% busy" would assert a clear channel on a band the adapter is not even
    # listening to, which is exactly what reached the screen before this.
    sampler = SurveySampler(
        iface="wlan1",
        runner=FakeRunner(
            MT7921U_MONITOR_MODE.format(active=10_000),
            MT7921U_MONITOR_MODE.format(active=20_254),
        ),
    )

    sampler.sample()
    assert sampler.sample() == []
    assert sampler.available is True  # iw answered
    assert "no busy time" in sampler.reason  # but said nothing worth drawing
    assert sampler.seen == 1


def test_the_first_window_is_not_reported_as_broken_hardware() -> None:
    # The first sample after a start has nothing to difference against. That is
    # not the adapter failing, and one heartbeat of "this adapter cannot do
    # occupancy" on every sensor restart would be a lie with a short life.
    sampler = SurveySampler(
        iface="wlan1", runner=FakeRunner(MT7921U_MONITOR_MODE.format(active=10_000))
    )

    assert sampler.sample() == []
    assert sampler.reason == ""


def test_a_noise_reading_alone_is_enough_to_be_worth_reporting() -> None:
    # A driver that gives a noise floor but no busy counter still measured
    # something real about the channel.
    quiet = (
        "Survey data from wlan1\n"
        "\tfrequency:\t2437 MHz [in use]\n"
        "\tnoise:\t-95 dBm\n"
        "\tchannel active time:\t{active} ms\n"
        "\tchannel busy time:\t0 ms\n"
    )
    sampler = SurveySampler(
        iface="wlan1",
        runner=FakeRunner(quiet.format(active=1_000), quiet.format(active=2_000)),
    )

    sampler.sample()
    [entry] = sampler.sample()
    assert entry["noise_dbm"] == -95
    assert entry["busy_fraction"] == 0
    assert sampler.reason == ""


def test_no_iw_at_all_is_reported_differently_from_a_useless_survey() -> None:
    # One needs a package installed; the other needs different hardware. An
    # operator should not have to guess which.
    sampler = SurveySampler(iface="wlan1", runner=lambda _iface: "")
    sampler.sample()
    assert sampler.available is False
    assert "no survey" in sampler.reason
