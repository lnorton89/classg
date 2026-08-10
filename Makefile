.PHONY: help setup test test-wifi test-fusion test-api test-ui test-sdr lint build-ui clean monitor capture

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
	cd services/api && go mod download
	cd services/ui && npm ci
	cd services/sensor-sdr && cargo fetch

test: test-wifi test-fusion test-api test-ui test-sdr

test-wifi:
	cd services/sensor-wifi && python -m pytest

test-fusion:
	cd services/fusion && go test -race -count=1 ./...

test-api:
	cd services/api && go test -count=1 ./...

test-ui:
	cd services/ui && npm test -- --run

build-ui:
	cd services/ui && npm run build

test-sdr:
	cd services/sensor-sdr && cargo test

# Mirrors .github/workflows/ci.yml -- if this passes, CI should too.
lint:
	cd services/sensor-wifi && python -m ruff check . && python -m mypy classg_wifi
	cd services/fusion && gofmt -l . && go vet ./...
	cd services/api && gofmt -l . && go vet ./...
	cd services/ui && npm run format:check && npm run lint && npm run typecheck
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
	rm -rf services/ui/dist services/ui/coverage
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
	find . -type d -name .pytest_cache -exec rm -rf {} + 2>/dev/null || true
