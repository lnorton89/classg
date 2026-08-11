.PHONY: help env migrate-env migrate-env-dry setup sense sqlc sqlc-check dev dev-logs dev-down dev-restart dev-native dev-ui-only test test-wifi test-fusion test-api test-ui test-sdr lint build-ui dev-api dev-ui compose-config compose-up compose-down clean monitor capture

DOCKER := bash ./scripts/docker.sh

help:
	@echo "ClassG - passive drone detection"
	@echo ""
	@echo "  make dev        dev stack in Docker: hot reload, no image rebuilds"
	@echo "  make dev-logs   follow the dev stack"
	@echo "  make dev-down   stop the dev stack"
	@echo "  make setup      install dependencies for all services"
	@echo "  make env        create ignored .env from .env.example"
	@echo "  make migrate-env  update an existing .env to the ADR-0007 tiers"
	@echo "  make test       run all test suites"
	@echo "  make lint       run all linters"
	@echo "  make monitor    put the Wi-Fi adapter into passive monitor mode"
	@echo "  make sense      run the live sensor (root, monitor mode)"
	@echo "  make capture    record a beacon PCAP (Milestone 0 ground truth)"
	@echo "  make compose-up build and start fusion, API, and UI via Windows Docker"
	@echo ""
	@echo "Start here: docs/research/02-hardware-capabilities.md"

env:
	@test -f .env || cp .env.example .env

# Migrate an existing .env to the ADR-0007 tier split. Backs up first, reports
# what moved, and leaves customised-but-immutable values in place.
migrate-env:
	./scripts/migrate-env.sh

migrate-env-dry:
	./scripts/migrate-env.sh --dry-run

setup: env
	cd services/sensor-wifi && python3 -m venv .venv
	cd services/sensor-wifi && .venv/bin/python -m pip install -e '.[dev,replay]'
	cd services/fusion && go mod download
	cd services/api && go mod download
	cd services/ui && npm ci
	cd services/sensor-sdr && cargo fetch

# SQL is derived from schema.sql, never hand-written in Go. Regenerate after
# editing either .sql file; CI fails if the committed output is stale.
sqlc:
	cd services/api && sqlc generate

sqlc-check:
	cd services/api && sqlc diff

test: test-wifi test-fusion test-api test-ui test-sdr

test-wifi:
	cd services/sensor-wifi && .venv/bin/python -m pytest

test-fusion:
	cd services/fusion && go test -race -count=1 ./...

test-api:
	cd services/api && go test -count=1 ./...

test-ui:
	cd services/ui && npm test -- --run

build-ui:
	cd services/ui && npm run build

# Primary dev loop: the whole stack in Docker with bind mounts and hot reload.
# No image rebuild is needed to see a code change -- air rebuilds the Go
# binaries in-container and Vite serves the UI with HMR.
dev: env
	@./scripts/dev-preflight.sh
	$(DOCKER) compose --env-file .env -f docker/docker-compose.dev.yml up -d --build
	@echo ""
	@echo "  UI   http://localhost:5173"
	@echo "  API  http://localhost:8081/api/v1"
	@echo ""
	@echo "  make dev-logs   follow all three services"
	@echo "  make dev-down   stop"

dev-logs:
	$(DOCKER) compose --env-file .env -f docker/docker-compose.dev.yml logs -f

dev-down:
	$(DOCKER) compose --env-file .env -f docker/docker-compose.dev.yml down

dev-restart:
	$(DOCKER) compose --env-file .env -f docker/docker-compose.dev.yml restart

# Same loop without containers. Faster still, but needs Go, Node and air on the
# host; kept for working on a Pi directly.
dev-native: env
	./scripts/dev.sh

dev-ui-only: env
	./scripts/dev.sh --ui-only

# Single services, for when you want one terminal per process.
# Note CLASSG_UI_DIR=off: in dev, Vite serves the UI. Letting the Go binary
# serve a stale dist/ is the most confusing failure in this project -- you edit
# a component, reload, and see yesterday's build.
dev-api: env
	cd services/api && CLASSG_UI_DIR=off go run ./cmd/classg-api

dev-ui: env
	cd services/ui && npm run dev

compose-up: env
	$(DOCKER) compose --env-file .env -f docker/docker-compose.yml up -d --build

compose-config: env
	$(DOCKER) compose --env-file .env -f docker/docker-compose.yml config

compose-down:
	$(DOCKER) compose --env-file .env -f docker/docker-compose.yml down

test-sdr:
	cd services/sensor-sdr && cargo test

# Mirrors .github/workflows/ci.yml -- if this passes, CI should too.
lint:
	cd services/sensor-wifi && .venv/bin/python -m ruff check . && .venv/bin/python -m mypy classg_wifi
	cd services/fusion && gofmt -l . && go vet ./...
	cd services/api && gofmt -l . && go vet ./...
	cd services/ui && npm run format:check && npm run lint && npm run typecheck
	cd services/sensor-sdr && cargo fmt --check && cargo clippy --all-targets -- -D warnings

# IFACE is overridable: make monitor IFACE=wlan2
IFACE ?= wlan1

monitor:
	sudo ./scripts/setup-monitor.sh $(IFACE)

# Live detection. Needs root for AF_PACKET, and monitor mode already set
# (make monitor). Run from the repo root -- the recipe cds for you, because the
# sensor's default config paths are relative to services/sensor-wifi.
sense:
	cd services/sensor-wifi && sudo .venv/bin/python -m classg_wifi.cli run 		--iface $(IFACE) $(SENSE_ARGS)

capture:
	@mkdir -p captures
	sudo tcpdump -i $(IFACE) -w captures/capture-$$(date +%Y%m%d-%H%M%S).pcap \
		"type mgt subtype beacon"

clean:
	cd services/sensor-sdr && cargo clean
	rm -rf services/ui/dist services/ui/coverage
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
	find . -type d -name .pytest_cache -exec rm -rf {} + 2>/dev/null || true
