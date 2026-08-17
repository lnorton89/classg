//! ULID minting for `detection_id`.
//!
//! The schema constrains the field to `^[0-9A-HJKMNP-TV-Z]{26}$` -- Crockford
//! base32, 48 bits of millisecond timestamp followed by 80 bits of randomness.
//! The timestamp prefix is the point: detection IDs sort lexicographically by
//! creation time, so storage can range-scan them.
//!
//! This mirrors `classg_wifi/detection.py::_ulid`, deliberately, so both sensors
//! mint the same shape of identifier.

/// Crockford base32: no I, L, O or U, which is exactly the schema's character
/// class.
const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// xorshift64*, seeded once per process.
///
/// Not cryptographic and does not need to be: a detection ID is a correlation
/// handle, not a capability. What it does need is to not collide within a
/// process, which 80 bits per millisecond covers comfortably.
pub struct UlidFactory {
    state: u64,
}

impl UlidFactory {
    pub fn new() -> Self {
        Self::seeded(seed())
    }

    pub fn seeded(seed: u64) -> Self {
        // A zero state is a fixed point of xorshift, so it would emit the same
        // ID forever -- and it is reachable if the clock reads exactly zero.
        Self {
            state: if seed == 0 {
                0x2545_F491_4F6C_DD1D
            } else {
                seed
            },
        }
    }

    fn next_u64(&mut self) -> u64 {
        self.state ^= self.state << 13;
        self.state ^= self.state >> 7;
        self.state ^= self.state << 17;
        self.state.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    pub fn mint(&mut self, epoch_ms: i64) -> String {
        // A clock before 1970 (no RTC, no NTP yet) would otherwise wrap into
        // the high bits and stop sorting. Clamping keeps the ID well-formed;
        // the detection's own `ts` still carries the wrong time, which is the
        // honest place for that error to show.
        let ms = epoch_ms.max(0) as u64 & 0xFFFF_FFFF_FFFF;
        let rand = ((self.next_u64() as u128) << 16) | (self.next_u64() as u128 & 0xFFFF);

        let mut out = String::with_capacity(26);
        for i in 0..10 {
            out.push(CROCKFORD[((ms >> (45 - 5 * i)) & 0x1F) as usize] as char);
        }
        for i in 0..16 {
            out.push(CROCKFORD[((rand >> (75 - 5 * i)) & 0x1F) as usize] as char);
        }
        out
    }
}

impl Default for UlidFactory {
    fn default() -> Self {
        Self::new()
    }
}

fn seed() -> u64 {
    // Clock plus PID: two processes started in the same millisecond (systemd
    // restarting both sensors at once) would otherwise mint identical streams.
    let now = crate::clock::epoch_ms() as u64;
    now.rotate_left(17) ^ u64::from(std::process::id()).wrapping_mul(0x9E37_79B9_7F4A_7C15)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn is_schema_shaped(s: &str) -> bool {
        s.len() == 26
            && s.bytes()
                .all(|b| b.is_ascii_digit() || b.is_ascii_uppercase() && !b"ILOU".contains(&b))
    }

    #[test]
    fn matches_the_schema_pattern() {
        let mut f = UlidFactory::seeded(1);
        for ms in [0i64, 1, 1_786_458_191_482, i64::from(u32::MAX)] {
            let id = f.mint(ms);
            assert!(is_schema_shaped(&id), "{id} for {ms}");
        }
    }

    /// The reason for the timestamp prefix. If this stops holding, storage's
    /// range scans silently return the wrong rows.
    #[test]
    fn sorts_lexicographically_by_time() {
        let mut f = UlidFactory::seeded(7);
        let mut previous = f.mint(0);
        for ms in [1i64, 1_000, 1_786_458_191_482, 281_474_976_710_655] {
            let id = f.mint(ms);
            assert!(previous < id, "{previous} should sort before {id}");
            previous = id;
        }
    }

    #[test]
    fn is_unique_within_a_millisecond() {
        let mut f = UlidFactory::seeded(42);
        let ids: std::collections::HashSet<String> =
            (0..10_000).map(|_| f.mint(1_786_458_191_482)).collect();
        assert_eq!(ids.len(), 10_000);
    }

    /// Two IDs minted in the same millisecond share their first ten characters
    /// and differ after them -- which is what proves the split between the
    /// timestamp and the random half is where it should be.
    #[test]
    fn the_timestamp_half_is_the_first_ten_characters() {
        let mut f = UlidFactory::seeded(3);
        let a = f.mint(1_786_458_191_482);
        let b = f.mint(1_786_458_191_482);
        assert_eq!(a[..10], b[..10]);
        assert_ne!(a[10..], b[10..]);
    }

    /// An unset clock must not produce an ID that fails the schema pattern.
    #[test]
    fn a_prehistoric_clock_still_mints_a_valid_id() {
        let mut f = UlidFactory::seeded(9);
        let id = f.mint(-1_000);
        assert!(is_schema_shaped(&id), "{id}");
    }

    #[test]
    fn a_zero_seed_does_not_freeze_the_generator() {
        let mut f = UlidFactory::seeded(0);
        assert_ne!(f.mint(1)[10..], f.mint(1)[10..]);
    }
}
