package capture

import (
	"encoding/binary"
	"errors"
	"io"
	"os"
)

// Classic PCAP magic numbers. The byte order of the magic tells us the byte
// order of everything after it; the two "nanosecond" variants differ only in
// the units of the timestamp field, which a frame count does not care about.
const (
	magicMicroBE = 0xa1b2c3d4
	magicMicroLE = 0xd4c3b2a1
	magicNanoBE  = 0xa1b23c4d
	magicNanoLE  = 0x4d3cb2a1
	magicPcapNG  = 0x0a0d0d0a

	pcapGlobalHeaderLen = 24
	pcapPacketHeaderLen = 16

	// A single 802.11 frame cannot approach this. Capping the declared length
	// stops a truncated or corrupt file from turning into a huge seek.
	maxPacketLen = 1 << 22 // 4 MiB
)

var errNotClassicPcap = errors.New("not a classic pcap file")

// countFrames returns the number of packets in a capture.
//
// Parsed directly rather than shelled out to tcpdump. The API runs in a
// container that has no tcpdump, and the previous implementation silently
// returned 0 there -- reporting a perfectly good 779-frame capture as empty,
// which reads as a broken capture rather than a missing tool.
func countFrames(path string) int {
	f, err := os.Open(path)
	if err != nil {
		return 0
	}
	defer f.Close()

	n, err := countPcapPackets(f)
	if err != nil {
		return 0
	}
	return n
}

func countPcapPackets(r io.ReadSeeker) (int, error) {
	// Total size up front. Seeking past EOF is legal, so without knowing where
	// the file ends a truncated final payload would be counted as a whole frame.
	size, err := r.Seek(0, io.SeekEnd)
	if err != nil {
		return 0, err
	}
	if _, err := r.Seek(0, io.SeekStart); err != nil {
		return 0, err
	}

	var header [pcapGlobalHeaderLen]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		return 0, err
	}

	var order binary.ByteOrder
	switch magic := binary.BigEndian.Uint32(header[0:4]); magic {
	case magicMicroBE, magicNanoBE:
		order = binary.BigEndian
	case magicMicroLE, magicNanoLE:
		order = binary.LittleEndian
	case magicPcapNG:
		// Block-structured and a different problem. Our tooling writes classic
		// pcap, so this is reported as unknown rather than guessed at.
		return 0, errNotClassicPcap
	default:
		return 0, errNotClassicPcap
	}

	count := 0
	var pkt [pcapPacketHeaderLen]byte
	for {
		if _, err := io.ReadFull(r, pkt[:]); err != nil {
			if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
				// A trailing partial record means the capture was cut off
				// mid-write, which is normal for a Ctrl-C'd tcpdump.
				return count, nil
			}
			return count, err
		}
		inclLen := order.Uint32(pkt[8:12])
		if inclLen > maxPacketLen {
			return count, errNotClassicPcap
		}
		end, err := r.Seek(int64(inclLen), io.SeekCurrent)
		if err != nil {
			return count, err
		}
		if end > size {
			// The record header promised more payload than the file holds: the
			// capture was cut off mid-packet. The frames before it are real.
			return count, nil
		}
		count++
	}
}
