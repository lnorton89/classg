"""Regression test for the DJI vendor IE header offset.

`parsers/dji.py` used to read the subcommand at byte 4 (OUI(3) + one vendor
byte), which is two bytes short of where DJI actually puts it: Kismet's
independent dot11_ie_221_dji_droneid parser (both the .h class and the .ksy
struct) place `vendor_type`, `unk1`, and `unk2` -- three single-byte fields,
not one -- between the OUI and the subcommand.

This vector is one committed hex capture of a real 94-byte DJI DroneID vendor
IE, extracted with scapy from a third-party sample capture
(`mavic_alessa_spoofed.pcapng`, from the RemoteIDReceiver project on the unit).
It carries no real person's data -- the sample is a synthetic spoof frame, and
its serial and coordinates are not tied to any actual aircraft or operator.
Before the fix this IE's subcommand read as 0x62 and raised DjiParseError for
every frame of this shape; Class B would have decoded nothing from an
aircraft sending it.
"""

from __future__ import annotations

from classg_wifi.parsers import dji

# 26 37 12 | 58 62 13 | 10 | payload -- OUI, vendor_type, unk1, unk2, subcommand.
MAVIC_ALESSA_TELEMETRY_IE = bytes.fromhex(
    "26371258621310024d06331f4b365245"
    "3057454e414839503851414c019f2200"
    "3cf51f003700640034083c0f8403bcd0"
    "3f3ca05b000000001823950017847200"
    "1784720018239500580600616c657373"
    "6100000000000000000000000000"
)


def test_marker_bytes_match_the_committed_sample():
    assert MAVIC_ALESSA_TELEMETRY_IE[:7] == bytes.fromhex("26371258621310")


def test_decodes_as_telemetry_not_a_parse_error():
    payload = dji.parse_vendor_ie(MAVIC_ALESSA_TELEMETRY_IE)
    assert isinstance(payload, dji.DjiTelemetry)


def test_fields_decode_cleanly_at_the_corrected_offset():
    """A misaligned read would not coincidentally produce a clean ASCII serial."""
    payload = dji.parse_vendor_ie(MAVIC_ALESSA_TELEMETRY_IE)
    assert isinstance(payload, dji.DjiTelemetry)

    assert payload.version == 2
    assert payload.serial == "K6RE0WENAH9P8QAL"
    assert payload.lat is not None and payload.lon is not None


def test_truncated_payload_still_returns_partial_telemetry():
    """The reader's defensiveness must hold at the new offset too.

    A frame cut off mid-payload should yield None fields past the cut, not an
    exception -- DJI truncates these in the wild.
    """
    truncated = MAVIC_ALESSA_TELEMETRY_IE[:20]
    payload = dji.parse_vendor_ie(truncated)
    assert isinstance(payload, dji.DjiTelemetry)
    assert payload.version == 2
    assert payload.lat is None and payload.lon is None


def test_body_shorter_than_the_new_header_is_not_a_dji_ie():
    """7 bytes are now required to reach the subcommand; 6 must not be enough."""
    assert dji.parse_vendor_ie(MAVIC_ALESSA_TELEMETRY_IE[:6]) is None
