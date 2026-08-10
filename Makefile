.PHONY: help setup test test-wifi test-fusion test-sdr lint clean monitor capture

help:
	@echo "ClassG - passive drone detection"
	@echo ""
	@echo "  make setup      install dependencies for all services"
	@echo "  make test       run all test suites"
	@echo "  make lint       run all linters"
	@echo "  make monitor    put the Wi-Fi adapter into passive monitor mode"
	@echo "  make capture    record a beacon PCAP (Milestone 0 ground truth)"
	@echo ""
	@echo "Start here: docs/research/02-hardware-capabilities.md"

setup:
	cd services/sensor-wifi && python -m pip install -e '.[dev,replay]'
	cd services/fusion && go mod download
	cd services/sensor-sdr && cargo fetch

test: test-wifi test-fusion test-sdr

test-wifi:
	cd services/sensor-wifi && python -m pytest

test-fusion:
	cd services/fusion && go test -race -count=1 ./...

test-sdr:
	cd services/sensor-sdr && cargo test

# Mirrors .github/workflows/ci.yml -- if this passes, CI should too.
lint:
	cd services/sensor-wifi && python -m ruff check . && python -m mypy classg_wifi
	cd services/fusion && gofmt -l . && go vet ./...
	cd services/sensor-sdr && cargo fmt --check && cargo clippy --all-targets -- -D warnings

# IFACE is overridable: make monitor IFACE=wlan2
IFACE ?= wlan1

monitor:
	sudo ./scripts/setup-monitor.sh $(IFACE)

capture:
	@mkdir -p captures
	sudo tcpdump -i $(IFACE) -w captures/capture-$$(date +%Y%m%d-%H%M%S).pcap \
		"type mgt subtype beacon"

clean:
	cd services/sensor-sdr && cargo clean
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
	find . -type d -name .pytest_cache -exec rm -rf {} + 2>/dev/null || true
