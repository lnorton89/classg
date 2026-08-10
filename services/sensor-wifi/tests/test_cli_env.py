from __future__ import annotations

from pathlib import Path

from classg_wifi import cli


def test_cli_loads_root_env_and_explicit_process_env_wins(
    tmp_path: Path, monkeypatch
) -> None:
    (tmp_path / ".env").write_text(
        "CLASSG_WIFI_INTERFACE=env-wlan\nCLASSG_WIFI_CHANNEL=11\n"
    )
    work = tmp_path / "services" / "sensor-wifi"
    work.mkdir(parents=True)
    monkeypatch.chdir(work)
    monkeypatch.delenv("CLASSG_WIFI_INTERFACE", raising=False)
    monkeypatch.delenv("CLASSG_WIFI_CHANNEL", raising=False)

    seen = {}
    monkeypatch.setattr(cli, "cmd_capture", lambda args: seen.update(vars(args)) or 0)

    assert cli.main(["capture"]) == 0
    assert seen["iface"] == "env-wlan"
    assert seen["channel"] == 11

    monkeypatch.setenv("CLASSG_WIFI_INTERFACE", "shell-wlan")
    seen.clear()
    assert cli.main(["capture"]) == 0
    assert seen["iface"] == "shell-wlan"


def test_explicit_missing_env_file_fails(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("CLASSG_ENV_FILE", str(tmp_path / "missing.env"))

    try:
        cli._load_environment()
    except RuntimeError as exc:
        assert "CLASSG_ENV_FILE does not exist" in str(exc)
    else:
        raise AssertionError("missing explicit env file was silently ignored")
