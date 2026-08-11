"""sensor-wifi entry point.

Subcommands:
  capture   raw PCAP to disk (Milestone 0 ground truth - use this first)
  replay    run a PCAP through the pipeline; no hardware needed
  run       live capture -> parse -> publish
"""

from __future__ import annotations

import argparse
import logging
import os
import signal
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from types import FrameType
from typing import cast

from dotenv import find_dotenv, load_dotenv

from .bus import DEFAULT_ENDPOINT, DetectionPublisher
from .capture import CaptureError, run_capture
from .fingerprint import FingerprintMatcher
from .help_docs import render_cli_help, render_cli_topic, topic_ids
from .hopper import ChannelHopper, load_channels
from .pipeline import Pipeline

log = logging.getLogger("classg.sensor-wifi")

_running = True


def _load_environment() -> None:
    """Load the centralized root .env without overriding explicit variables."""
    explicit = os.getenv("CLASSG_ENV_FILE")
    if explicit:
        if not load_dotenv(explicit, override=False):
            raise RuntimeError(f"CLASSG_ENV_FILE does not exist: {explicit}")
        return
    candidate = find_dotenv(usecwd=True)
    if candidate:
        load_dotenv(candidate, override=False)


def _handle_signal(signum: int, _frame: FrameType | None) -> None:
    global _running
    log.info("received signal %d, shutting down", signum)
    _running = False


def _pcap_timestamp(meta: object) -> float | None:
    """Return classic-PCAP metadata as epoch seconds when available."""
    sec = getattr(meta, "sec", None)
    usec = getattr(meta, "usec", None)
    if sec is None:
        return None
    return float(sec) + float(usec or 0) / 1_000_000


def _iso_timestamp(epoch_s: float) -> str:
    return datetime.fromtimestamp(epoch_s, UTC).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def cmd_replay(args: argparse.Namespace) -> int:
    """Drive the pipeline from a PCAP and publish detections to the live bus."""
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

    # Preserve the capture's intervals but anchor its final packet at the
    # current time. Processing a two-minute PCAP in one second must not collapse
    # every detection onto the same instant, and publishing its original clock
    # would make an old capture immediately stale in fusion.
    last_capture_ts = None
    for _raw, meta in RawPcapReader(args.pcap):
        packet_ts = _pcap_timestamp(meta)
        if packet_ts is not None:
            last_capture_ts = packet_ts
    replay_end_ts = time.time()
    publisher = None
    if args.publish:
        publisher = DetectionPublisher(
            endpoint=args.endpoint,
            hwm=args.zmq_hwm,
            sensor_id=args.sensor_id,
            detection_topic=args.detection_topic,
            heartbeat_topic=args.heartbeat_topic,
            socket_mode=args.socket_mode,
        )
        # ZeroMQ PUB/SUB drops messages until subscribers finish joining.
        time.sleep(args.connect_delay_s)

    try:
        for raw, meta in RawPcapReader(args.pcap):
            for detection in pipeline.process_frame(bytes(raw)):
                packet_ts = _pcap_timestamp(meta)
                if packet_ts is not None and last_capture_ts is not None:
                    detection["ts"] = _iso_timestamp(
                        replay_end_ts - (last_capture_ts - packet_ts)
                    )
                if publisher is not None:
                    publisher.publish(detection)
                if args.print_detections:
                    print(
                        detection["detection_class"],
                        detection["identity"].get("serial"),
                        detection.get("position"),
                    )

        if publisher is not None:
            publisher.heartbeat(
                healthy=True,
                detail={"mode": "replay", "pcap": str(args.pcap)},
            )
            # Give the I/O thread a bounded window to put queued frames on wire
            # before DetectionPublisher's zero-linger socket closes.
            time.sleep(args.settle_delay_s)
    finally:
        if publisher is not None:
            publisher.close()

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


def cmd_analyze(args: argparse.Namespace) -> int:
    """Milestone 0: turn a capture into channel, interval, and calibration data."""
    try:
        from .analyze import analyze_pcap, render_report, summarize_channels
    except ImportError:
        log.error("analyze requires scapy: pip install '.[replay]'")
        return 1

    result = analyze_pcap(args.pcap)
    print(render_report(result))

    channels = summarize_channels(result)
    if channels:
        print("\nDrone beacons per channel (evidence for config/channels.yaml):")
        for ch, n in sorted(channels.items(), key=lambda kv: -kv[1]):
            print(f"  ch {ch:<4} {n}")

    return 0 if result.drones else 1


def cmd_run(args: argparse.Namespace) -> int:
    import yaml

    channels = load_channels(yaml.safe_load(Path(args.channels).read_text()))
    hopper = ChannelHopper(channels, base_dwell_ms=args.dwell_ms)
    matcher = FingerprintMatcher.from_yaml(args.fingerprints)
    pipeline = Pipeline(sensor_id=args.sensor_id, matcher=matcher)
    publisher = DetectionPublisher(
        endpoint=args.endpoint,
        hwm=args.zmq_hwm,
        sensor_id=args.sensor_id,
        detection_topic=args.detection_topic,
        heartbeat_topic=args.heartbeat_topic,
        socket_mode=args.socket_mode,
    )

    log.info(
        "sensor %s: %s, %d channels, %d ms base dwell",
        args.sensor_id, args.iface, len(channels), args.dwell_ms,
    )
    try:
        run_capture(
            iface=args.iface,
            hopper=hopper,
            pipeline=pipeline,
            publisher=publisher,
            heartbeat_s=args.heartbeat_s,
            # A wedged capture loop stops heartbeating; without this the sensor
            # stays "alive" and blind. 4.5x leaves room for a slow dwell.
            watchdog_s=args.heartbeat_s * 4.5,
            should_run=lambda: _running,
        )
    except CaptureError as exc:
        # The radio is unusable. Say so on the bus before exiting so /health
        # shows a broken sensor rather than a quiet sky, then exit non-zero and
        # let systemd restart with backoff (ADR-0003).
        log.error("%s", exc)
        publisher.heartbeat(healthy=False, detail={"reason": str(exc)})
        publisher.close()
        return 1
    except KeyboardInterrupt:
        pass

    publisher.close()
    return 0


def main(argv: list[str] | None = None) -> int:
    cli_args = list(sys.argv[1:] if argv is None else argv)
    if "--help-topic" in cli_args:
        index = cli_args.index("--help-topic")
        if index + 1 >= len(cli_args):
            print("classg-sensor-wifi: --help-topic requires a topic", file=sys.stderr)
            return 2
        try:
            print(render_cli_topic(cli_args[index + 1]))
        except ValueError as exc:
            print(f"classg-sensor-wifi: {exc}", file=sys.stderr)
            return 2
        return 0

    _load_environment()
    parser = argparse.ArgumentParser(
        prog="classg-sensor-wifi",
        description="ClassG Wi-Fi sensor",
        epilog=render_cli_help(),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--verbose", "-v", action="store_true")
    parser.add_argument("--sensor-id", default=os.getenv("CLASSG_WIFI_SENSOR_ID", "wifi-0"))
    parser.add_argument(
        "--help-topic",
        choices=topic_ids(),
        metavar="TOPIC",
        help="show one shared documentation topic and exit",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_cap = sub.add_parser("capture", help="record beacons to PCAP")
    p_cap.add_argument("--iface", default=os.getenv("CLASSG_WIFI_INTERFACE", "wlan1"))
    p_cap.add_argument("--channel", type=int, default=os.getenv("CLASSG_WIFI_CHANNEL", "6"))
    p_cap.add_argument(
        "--out", default=os.getenv("CLASSG_WIFI_CAPTURE_OUT", "captures/capture.pcap")
    )
    p_cap.set_defaults(func=cmd_capture)

    p_rep = sub.add_parser("replay", help="publish detections from a PCAP")
    p_rep.add_argument("pcap")
    p_rep.add_argument(
        "--fingerprints",
        default=os.getenv("CLASSG_WIFI_FINGERPRINTS_FILE", "data/oui_fingerprints.yaml"),
    )
    p_rep.add_argument(
        "--endpoint", default=os.getenv("CLASSG_DETECTION_ENDPOINT", DEFAULT_ENDPOINT)
    )
    p_rep.add_argument(
        "--detection-topic", default=os.getenv("CLASSG_DETECTION_TOPIC", "detection.")
    )
    p_rep.add_argument(
        "--heartbeat-topic", default=os.getenv("CLASSG_HEARTBEAT_TOPIC", "heartbeat.")
    )
    p_rep.add_argument(
        "--socket-mode",
        choices=("bind", "connect"),
        default=os.getenv("CLASSG_WIFI_SOCKET_MODE", "bind"),
        help="bind for native runs; connect when Docker exposes the bus ingress",
    )
    p_rep.add_argument(
        "--zmq-hwm", type=int, default=os.getenv("CLASSG_WIFI_ZMQ_HWM", "1000")
    )
    p_rep.add_argument(
        "--publish",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="publish to ZeroMQ (default: true; use --no-publish for parser-only replay)",
    )
    p_rep.add_argument(
        "--print",
        dest="print_detections",
        action="store_true",
        help="also print each decoded detection",
    )
    p_rep.add_argument("--connect-delay-s", type=float, default=0.5)
    p_rep.add_argument("--settle-delay-s", type=float, default=0.25)
    p_rep.set_defaults(func=cmd_replay)

    p_ana = sub.add_parser("analyze", help="Milestone 0 report: channel, interval, calibration")
    p_ana.add_argument("pcap")
    p_ana.set_defaults(func=cmd_analyze)

    p_run = sub.add_parser("run", help="live capture and publish")
    p_run.add_argument("--iface", default=os.getenv("CLASSG_WIFI_INTERFACE", "wlan1"))
    p_run.add_argument(
        "--channels",
        default=os.getenv("CLASSG_WIFI_CHANNELS_FILE", "config/channels.yaml"),
    )
    p_run.add_argument(
        "--fingerprints",
        default=os.getenv("CLASSG_WIFI_FINGERPRINTS_FILE", "data/oui_fingerprints.yaml"),
    )
    p_run.add_argument(
        "--endpoint", default=os.getenv("CLASSG_DETECTION_ENDPOINT", DEFAULT_ENDPOINT)
    )
    p_run.add_argument(
        "--detection-topic", default=os.getenv("CLASSG_DETECTION_TOPIC", "detection.")
    )
    p_run.add_argument(
        "--heartbeat-topic", default=os.getenv("CLASSG_HEARTBEAT_TOPIC", "heartbeat.")
    )
    p_run.add_argument(
        "--socket-mode",
        choices=("bind", "connect"),
        default=os.getenv("CLASSG_WIFI_SOCKET_MODE", "bind"),
    )
    p_run.add_argument(
        "--dwell-ms", type=int, default=os.getenv("CLASSG_WIFI_DWELL_MS", "400")
    )
    p_run.add_argument(
        "--heartbeat-s",
        type=float,
        default=os.getenv("CLASSG_WIFI_HEARTBEAT_S", "10"),
    )
    p_run.add_argument(
        "--zmq-hwm", type=int, default=os.getenv("CLASSG_WIFI_ZMQ_HWM", "1000")
    )
    p_run.set_defaults(func=cmd_run)

    args = parser.parse_args(cli_args)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
    )
    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)
    return cast(int, args.func(args))


if __name__ == "__main__":
    sys.exit(main())
