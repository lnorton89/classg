// Package ulid generates the identifier format the schemas already use.
//
// Hand-rolled rather than pulled in as a dependency: the format is 48 bits of
// millisecond timestamp plus 80 bits of randomness in Crockford base32, and
// the only property the api relies on is that identifiers sort by creation
// time, which makes keyset pagination over them stable.
package ulid

import (
	"crypto/rand"
	"time"
)

const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

// New returns a 26-character ULID for t.
func New(t time.Time) string {
	var id [26]byte

	ms := uint64(t.UTC().UnixMilli())
	for i := 9; i >= 0; i-- {
		id[i] = crockford[ms&0x1f]
		ms >>= 5
	}

	var entropy [10]byte
	if _, err := rand.Read(entropy[:]); err != nil {
		// crypto/rand does not fail on any supported platform; if it somehow
		// does, a timestamp-only identifier still sorts correctly and stays
		// unique at the rates this system generates identifiers.
		for i := 10; i < 26; i++ {
			id[i] = '0'
		}
		return string(id[:])
	}

	// 80 bits of entropy into 16 base32 characters, five bits at a time.
	var acc uint64
	var bits uint
	pos := 10
	for _, b := range entropy {
		acc = acc<<8 | uint64(b)
		bits += 8
		for bits >= 5 && pos < 26 {
			bits -= 5
			id[pos] = crockford[(acc>>bits)&0x1f]
			pos++
		}
	}
	for pos < 26 {
		id[pos] = '0'
		pos++
	}
	return string(id[:])
}

// Now is the common case.
func Now() string { return New(time.Now()) }
