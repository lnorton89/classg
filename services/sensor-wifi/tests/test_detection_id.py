"""The identifier format, which the whole system sorts and pages by.

Four services hand-roll this: two Go modules, sensor-sdr in Rust, and here.
Nothing shares code, so nothing shares a compiler either, and
``scripts/check-mirrors.py`` compares the four alphabets and the pre-epoch
guard. These tests are the behavioural half of that.
"""

from __future__ import annotations

from classg_wifi.detection import _ULID_ALPHABET, _ulid

RAND = bytes(range(10))
PRESENT_MS = 1_786_000_000_000  # some time in 2026


def test_sorts_by_creation_time() -> None:
    """The one property the rest of the system leans on.

    Detection ids reach the API's keyset cursors, and a page boundary lands
    between two adjacent milliseconds far more often than between two seconds.
    """
    ids = [_ulid(RAND, PRESENT_MS + n) for n in range(200)]
    assert ids == sorted(ids)
    # Byte order has to recover creation order after a shuffle, because that is
    # what the database does with them.
    assert sorted(reversed(ids)) == ids


def test_shape_matches_the_schema() -> None:
    got = _ulid(RAND, PRESENT_MS)
    assert len(got) == 26
    assert set(got) <= set(_ULID_ALPHABET)


def test_the_alphabet_is_crockford_in_byte_order() -> None:
    # No I, L, O or U -- the first three read as 1 and 0 off a screen, U makes
    # accidental words -- and ascending, or byte order stops matching value
    # order and the sort above holds only by luck.
    assert len(_ULID_ALPHABET) == 32
    assert not (set("ILOU") & set(_ULID_ALPHABET))
    assert list(_ULID_ALPHABET) == sorted(_ULID_ALPHABET)


def test_randomness_reaches_the_suffix() -> None:
    """Two detections in the same millisecond must not collide."""
    at = PRESENT_MS
    a = _ulid(b"\x00" * 10, at)
    b = _ulid(b"\xff" * 10, at)
    assert a != b
    # ...and only in the suffix. The first ten characters are the timestamp.
    assert a[:10] == b[:10]
    assert a[10:] != b[10:]


def test_a_clock_before_the_epoch_still_sorts_first() -> None:
    """A Pi has no RTC, so an unsynchronised clock is a first-boot state.

    Without the clamp this is not merely a smaller number: Python's integers
    sign-extend for ever, so every masked group comes back 0x1F and the id
    reads ``ZZZZZZZZZZ...`` -- which sorts after every real identifier and sits
    at the end of every keyset page for good, where nothing about it looks
    wrong. sensor-sdr's ulid.rs guards the same case.
    """
    present = _ulid(RAND, PRESENT_MS)
    for ts_ms in (0, -1, -86_400_000, -(1 << 60)):
        got = _ulid(RAND, ts_ms)
        assert len(got) == 26, ts_ms
        assert set(got) <= set(_ULID_ALPHABET), ts_ms
        assert got < present, f"{ts_ms} minted {got}, which sorts after {present}"


def test_short_random_input_is_padded_not_rejected() -> None:
    """rand_bytes shorter than ten is padded rather than raising.

    A detection that failed to mint an id would be a detection lost, and the
    sensor's job is to degrade rather than drop (ADR-0003).
    """
    got = _ulid(b"\x01", PRESENT_MS)
    assert len(got) == 26
    assert set(got) <= set(_ULID_ALPHABET)
