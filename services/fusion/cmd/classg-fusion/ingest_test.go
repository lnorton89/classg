package main

import (
	"testing"
	"time"
)

// The hop between the socket reader and the ingest loop must absorb a burst.
//
// It was unbuffered, which made receiving and processing one serial operation:
// the reader blocks on the handoff until the loop finishes the previous
// message, so the socket is not being drained during that time and ZMQ
// discards what it cannot hold. Heartbeats are just messages on the same
// socket, so they went with the detections -- and every sensor flapped to
// "heartbeat stale" the moment a drone produced a burst, including one
// producing no detections of its own, because all of them share that socket.
//
// Modelled here rather than driven through a real socket: what matters is that
// a reader emitting a burst does not stall behind a consumer, which is a
// property of the channel and not of ZMQ.
func TestABurstDoesNotStallTheReader(t *testing.T) {
	messages := make(chan busMessage, busQueueDepth)

	// A consumer that is momentarily busy, the way the ingest loop is while it
	// parses and correlates a detection.
	consumerStarted := make(chan struct{})
	go func() {
		<-consumerStarted
		for range messages {
			time.Sleep(time.Millisecond)
		}
	}()

	// A reader emitting a burst BEFORE the consumer runs at all. Unbuffered,
	// this deadlocks on the first send and the test times out; buffered, the
	// reader stays free to keep draining its socket.
	const burst = 500
	done := make(chan int, 1)
	go func() {
		sent := 0
		for i := 0; i < burst; i++ {
			select {
			case messages <- busMessage{topic: "heartbeat.wifi", body: []byte("{}")}:
				sent++
			case <-time.After(2 * time.Second):
				done <- sent
				return
			}
		}
		done <- sent
	}()

	select {
	case sent := <-done:
		if sent != burst {
			t.Fatalf("the reader stalled after %d of %d messages; a burst this size is one "+
				"drone's detections, and every message it cannot hand off is one ZMQ discards",
				sent, burst)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the reader never finished the burst")
	}
	close(consumerStarted)
}

// The depth is not arbitrary: it matches the sensors' publisher high-water
// mark, so a burst their side was willing to hold is one this side accepts.
// A depth below it means the two ends disagree about what a burst is.
func TestQueueDepthMatchesThePublisherHighWaterMark(t *testing.T) {
	// classg_wifi/bus.py: "publishing detections via ... (connect, hwm=1000)"
	const sensorHWM = 1000
	if busQueueDepth < sensorHWM {
		t.Errorf("busQueueDepth is %d but a sensor will hold %d before dropping; the "+
			"receiving end should not be the narrower of the two", busQueueDepth, sensorHWM)
	}
}
