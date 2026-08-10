from __future__ import annotations

import pytest

from classg_wifi import cli
from classg_wifi.help_docs import load_operator_guide, render_cli_help, render_cli_topic


def test_shared_operator_guide_renders_for_cli() -> None:
    guide = load_operator_guide()
    rendered = render_cli_help()

    assert guide["title"] == "ClassG documentation"
    assert "DOCUMENTATION" in rendered
    assert "sensor-wifi" in rendered
    assert "--help-topic TOPIC" in rendered


def test_standard_help_includes_operator_guide(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as exc:
        cli.main(["--help"])

    assert exc.value.code == 0
    output = capsys.readouterr().out
    assert output.startswith("usage: classg-sensor-wifi")
    assert "DOCUMENTATION" in output
    assert "Fusion service" in output


def test_help_topic_renders_one_component(capsys: pytest.CaptureFixture[str]) -> None:
    assert cli.main(["--help-topic", "api"]) == 0
    output = capsys.readouterr().out

    assert output.startswith("GO API")
    assert "services/api" in output
    assert "docs/architecture/api-contract.md" in output
    assert "SENSOR-WIFI" not in output


def test_unknown_help_topic_is_an_error(capsys: pytest.CaptureFixture[str]) -> None:
    assert cli.main(["--help-topic", "nope"]) == 2
    assert "unknown help topic" in capsys.readouterr().err


def test_topic_renderer_uses_shared_document() -> None:
    assert "go test ./..." in render_cli_topic("api")
