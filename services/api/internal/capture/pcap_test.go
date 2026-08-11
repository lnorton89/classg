package capture

import (
	"bytes"
	"encoding/binary"
	"os"
	"path/filepath"
	"testing"
)

// buildPcap writes a classic pcap with n packets of the given payload size.
func buildPcap(order binary.ByteOrder, magic uint32, n, payload int) []byte {
	var b bytes.Buffer
	hdr := make([]byte, 24)
	// The magic is written so that reading it big-endian yields the constant --
	// that is how the on-disk bytes actually look. A little-endian capture
	// starts d4 c3 b2 a1, and writing the constant with order.PutUint32 would
	// swap it back into the big-endian form and defeat the detection.
	binary.BigEndian.PutUint32(hdr[0:4], magic)
	order.PutUint16(hdr[4:6], 2)
	order.PutUint16(hdr[6:8], 4)
	order.PutUint32(hdr[16:20], 65535)
	order.PutUint32(hdr[20:24], 127) // radiotap
	b.Write(hdr)

	for i := 0; i < n; i++ {
		p := make([]byte, 16)
		order.PutUint32(p[0:4], uint32(1786000000+i))
		order.PutUint32(p[8:12], uint32(payload))
		order.PutUint32(p[12:16], uint32(payload))
		b.Write(p)
		b.Write(make([]byte, payload))
	}
	return b.Bytes()
}

func writeTemp(t *testing.T, data []byte) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "c.pcap")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestCountFramesBothByteOrders(t *testing.T) {
	cases := []struct {
		name  string
		order binary.ByteOrder
		magic uint32
	}{
		{"little-endian micro", binary.LittleEndian, magicMicroLE},
		{"big-endian micro", binary.BigEndian, magicMicroBE},
		{"little-endian nano", binary.LittleEndian, magicNanoLE},
		{"big-endian nano", binary.BigEndian, magicNanoBE},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := writeTemp(t, buildPcap(tc.order, tc.magic, 42, 100))
			if got := countFrames(path); got != 42 {
				t.Fatalf("got %d frames, want 42", got)
			}
		})
	}
}

func TestCountFramesEmptyCapture(t *testing.T) {
	path := writeTemp(t, buildPcap(binary.LittleEndian, magicMicroLE, 0, 0))
	if got := countFrames(path); got != 0 {
		t.Fatalf("got %d, want 0", got)
	}
}

func TestTruncatedFinalRecordCountsCompletePackets(t *testing.T) {
	// A Ctrl-C'd tcpdump leaves a partial trailing record. The frames before it
	// are real and must still be counted.
	data := buildPcap(binary.LittleEndian, magicMicroLE, 5, 50)
	path := writeTemp(t, data[:len(data)-20])
	if got := countFrames(path); got != 4 {
		t.Fatalf("got %d, want 4 complete frames", got)
	}
}

func TestGarbageIsZeroNotACrash(t *testing.T) {
	for _, data := range [][]byte{
		{},
		[]byte("not a pcap at all"),
		{0x0a, 0x0d, 0x0d, 0x0a, 0, 0, 0, 0}, // pcapng, deliberately unsupported
	} {
		if got := countFrames(writeTemp(t, data)); got != 0 {
			t.Fatalf("got %d, want 0", got)
		}
	}
}

func TestAbsurdPacketLengthRejected(t *testing.T) {
	// Guards against a corrupt length turning into a multi-gigabyte seek.
	data := buildPcap(binary.LittleEndian, magicMicroLE, 1, 10)
	binary.LittleEndian.PutUint32(data[24+8:24+12], 1<<30)
	if got := countFrames(writeTemp(t, data)); got != 0 {
		t.Fatalf("got %d, want 0", got)
	}
}

func TestCountsTheRealCapture(t *testing.T) {
	// The actual Milestone 0 capture, if present. classg_wifi.cli analyze
	// independently reports 779 frames for this file.
	path := filepath.Join("..", "..", "..", "..",
		"captures", "20260810-141223-dji-first-flight.pcap")
	if _, err := os.Stat(path); err != nil {
		t.Skip("real capture not present")
	}
	if got := countFrames(path); got != 779 {
		t.Fatalf("got %d frames, want 779", got)
	}
}
