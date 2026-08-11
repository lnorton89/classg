package fusion

import (
	"crypto/rand"
	"time"
)

const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

// NewTrackID returns a time-sortable 26-character ULID.
func NewTrackID() string { return NewULID() }

// NewULID returns a time-sortable 26-character ULID in Crockford base32.
//
// Detections and tracks share the generator because the schemas share the
// format; only the field names differ.
func NewULID() string {
	var id [26]byte
	ms := uint64(time.Now().UTC().UnixMilli())
	for i := 9; i >= 0; i-- {
		id[i] = crockford[ms&0x1f]
		ms >>= 5
	}

	var entropy [10]byte
	if _, err := rand.Read(entropy[:]); err != nil {
		for i := 10; i < len(id); i++ {
			id[i] = '0'
		}
		return string(id[:])
	}

	var acc uint64
	var bits uint
	pos := 10
	for _, b := range entropy {
		acc = acc<<8 | uint64(b)
		bits += 8
		for bits >= 5 && pos < len(id) {
			bits -= 5
			id[pos] = crockford[(acc>>bits)&0x1f]
			pos++
		}
	}
	return string(id[:])
}
