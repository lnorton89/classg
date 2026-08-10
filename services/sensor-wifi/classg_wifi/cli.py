"""sensor-wifi entry point.

Subcommands:
  capture   raw PCAP to disk (Milestone 0 ground truth - use this first)
  replay    run a PCAP through the pipeline; no hardware needed
  run       live capture -> parse -> publish
"""

from __future__ import annotations

import argparse
import logging
import signal
import sys
import time
from pathlib import Path
from types import FrameType
from typing import cast

from .bus import DEFAULT_ENDPOINT, DetectionPublisher
from .fingerprint import FingerprintMatcher
from .hopper import ChannelHopper, load_channels
from .pipeline import Pipeline

log = logging.getLogger("classg.sensor-wifi")

_running = True


def _handle_signal(signum: int, _frame: FrameType | None) -> None:
    global _running
    log.info("received signal %d, shutting down", signum)
    _running = False


def cmd_replay(args: argparse.Namespace) -> int:
    """Drive the pipeline from a PCAP. The regression harness for the parsers."""
    try:
        from scapy.utils import RawPcapReader
    except ImportError:
        log.error("replay requires scapy: pip install '.[replay]'")
        return 1

    matcher = (
        FingerprintMatcher.from_yaml(args.fingerprints)
        if Path(args.fingerprints).exists()
        else FingerprintMatcher.empty()
    )
    pipeline = Pipeline(sensor_id=args.sensor_id, matcher=matcher)

    for raw, _meta in RawPcapReader(args.pcap):
        for detection in pipeline.process_frame(bytes(raw)):
            print(detection["detection_class"], detection["identity"].get("serial"),
                  detection.get("position"))

    s = pipeline.stats
    log.info(
        "replay complete: %d frames, %d beacons, A=%d B=%d C=%d, %d parse errors",
        s.frames_seen, s.beacons, s.class_a, s.class_b, s.class_c, s.parse_errors,
    )
    return 0


def cmd_capture(args: argparse.Namespace) -> int:
    """Thin wrapper around tcpdump. Deliberately not reimplemented - tcpdump is
    better at this, and Milestone 0 wants a plain PCAP that Wireshark can open."""
    import subprocess

    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "tcpdump", "-i", args.iface, "-w", args.out,
        "type mgt subtype beacon",
    ]
    log.info("running: %s", " ".join(cmd))
    log.info("power on the drone, let it acquire GPS, hover, land. Ctrl-C when done.")
    return subprocess.call(cmd)


def cmd_run(args: argparse.Namespace) -> int:
    import yaml

    channels = load_channels(yaml.safe_load(Path(args.channels).read_text()))
    hopper = ChannelHopper(channels, base_dwell_ms=args.dwell_ms)
    matcher = FingerprintMatcher.from_yaml(args.fingerprints)
    pipeline = Pipeline(sensor_id=args.sensor_id, matcher=matcher)
    publisher = DetectionPublisher(endpoint=args.endpoint, sensor_id=args.sensor_id)

    # NOTE (Milestone 1): the live capture loop is not implemented yet.
    # It belongs here and must:
    #   1. open a raw AF_PACKET socket on args.iface (monitor mode, PASSIVE only)
    #   2. apply a BPF filter for management/beacon frames -- filter in the kernel,
    #      not in Python, so neighbours' traffic never reaches userspace
    #      (docs/research/06-legal-and-ethics.md#privacy-of-your-own-capture)
    #   3. for each dwell: set channel, read frames until dwell expires
    #   4. feed frames through pipeline.process_frame()
    #   5. publish results; call hopper.on_drone_detected() on Class A/B
    #   6. emit publisher.heartbeat() every N seconds REGARDLESS of detections
    log.error("live capture not implemented yet - see Milestone 1 in docs/planning/roadmap.md")
    log.info("meanwhile: 'capture' to record a PCAP, 'replay' to exercise the pipeline")

    last_heartbeat = 0.0
    while _running:
        now = time.time()
        if now - last_heartbeat >= args.heartbeat_s:
            publisher.heartbeat(
                healthy=False,
                detail={
                    "reason": "capture loop not implemented",
                    "hopper": hopper.efficiency_report(),
                    "frames_seen": pipeline.stats.frames_seen,
                },
            )
            last_heartbeat = now
        time.sleep(0.5)

    publisher.close()
    return 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="sensor-wifi", description="ClassG Wi-Fi sensor")
    parser.add_argument("--verbose", "-v", action="store_true")
    parser.add_argument("--sensor-id", default="wifi-0")
    sub = parser.add_subparsers(dest="command", required=True)

    p_cap = sub.add_parser("capture", help="record beacons to PCAP")
    p_cap.add_argument("--iface", default="wlan1")
    p_cap.add_argument("--channel", type=int, default=6)
    p_cap.add_argument("--out", default="captures/capture.pcap")
    p_cap.set_defaults(func=cmd_capture)

    p_rep = sub.add_parser("replay", help="run a PCAP through the pipeline")
    p_rep.add_argument("pcap")
    p_rep.add_argument("--fingerprints", default="data/oui_fingerprints.yaml")
    p_rep.set_defaults(func=cmd_replay)

    p_run = sub.add_parser("run", help="live capture and publish")
    p_run.add_argument("--iface", default="wlan1")
    p_run.add_argument("--channels", default="config/channels.yaml")
    p_run.add_argument("--fingerprints", default="data/oui_fingerprints.yaml")
    p_run.add_argument("--endpoint", default=DEFAULT_ENDPOINT)
    p_run.add_argument("--dwell-ms", type=int, default=400)
    p_run.add_argument("--heartbeat-s", type=float, default=10.0)
    p_run.set_defaults(func=cmd_run)

    args = parser.parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
    )
    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)
    return cast(int, args.func(args))


if __name__ == "__main__":
    sys.exit(main())
