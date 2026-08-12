{
  description = "ClassG — passive, multi-sensor drone detection for a Raspberry Pi";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };

        # go-libsql needs CGO; sensor-wifi's pyzmq needs libzmq
        buildInputs = with pkgs; [
          zeromq
          sqlite
        ];

        nativeBuildInputs = with pkgs; [
          pkg-config
        ];

        py = pkgs.python312;
      in
      {
        devShells.default = pkgs.mkShell {
          inherit buildInputs nativeBuildInputs;

          packages = with pkgs; [
            # === Go === (fusion + api, go 1.26)
            go_1_26

            # === Python === (sensor-wifi, 3.11/3.12)
            py
            py.pkgs.pytest
            py.pkgs.pytest-cov
            py.pkgs.hypothesis
            py.pkgs.jsonschema
            py.pkgs.ruff
            py.pkgs.mypy
            py.pkgs.pyyaml
            py.pkgs.python-dotenv
            py.pkgs.pyzmq
            py.pkgs.scapy

            # === Rust === (sensor-sdr, stable 2021 edition)
            rustc
            cargo
            clippy
            rustfmt

            # === Node === (ui, >=22; CI uses 24)
            nodejs_24

            # === Tooling ===
            sqlc
            shellcheck
            air
          ];

          # go-libsql needs CGO
          CGO_ENABLED = "1";

          shellHook = ''
            echo "ClassG dev shell — $(go version | awk '{print $3}') $(python3 --version | awk '{print $2}') $(rustc --version | awk '{print $2}') $(node --version)"
            echo ""
            echo "Quick start:"
            echo "  make env        create .env from .env.example"
            echo "  make setup      install per-language deps (venv, go mod, npm ci, cargo fetch)"
            echo "  make dev        full stack in Docker"
            echo "  make test       run all test suites"
            echo "  make lint       run all linters"
          '';
        };
      }
    );
}