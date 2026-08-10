"""Render the shared operator guide for terminal help.

The JSON document is also imported directly by the web UI. Keeping terminal
formatting here and prose there prevents the two operator surfaces from
quietly describing different workflows.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import NotRequired, TypedDict, cast


class GuideItem(TypedDict):
    title: str
    body: str
    command: NotRequired[str]
    path: NotRequired[str]


class GuideSection(TypedDict):
    id: str
    title: str
    description: str
    items: list[GuideItem]


class GuideDocument(TypedDict):
    id: str
    title: str
    area: str
    treePath: list[str]
    summary: str
    sections: list[GuideSection]


class OperatorGuide(TypedDict):
    version: int
    title: str
    summary: str
    documents: list[GuideDocument]


def guide_path() -> Path:
    """Find docs/operator-guide.json from an editable repository install."""
    candidates = [Path(__file__).resolve(), Path.cwd().resolve()]
    for start in candidates:
        for parent in (start, *start.parents):
            candidate = parent / "docs" / "operator-guide.json"
            if candidate.is_file():
                return candidate
    raise FileNotFoundError("docs/operator-guide.json was not found")


def load_operator_guide() -> OperatorGuide:
    return cast(OperatorGuide, json.loads(guide_path().read_text(encoding="utf-8")))


def render_cli_help() -> str:
    """Format the shared documentation catalog as an argparse epilog."""
    try:
        guide = load_operator_guide()
    except (FileNotFoundError, json.JSONDecodeError):
        return "Operator documentation: docs/operator-guide.json"

    lines = ["DOCUMENTATION", guide["summary"], "", "TOPICS"]
    for document in guide["documents"]:
        lines.extend(
            (
                f"  {document['id']:<16} {document['title']}",
                f"    {document['summary']}",
            )
        )
    lines.extend(
        (
            "",
            "Show one topic:",
            "  classg-sensor-wifi --help-topic TOPIC",
            "",
            "The same documents are available in the web UI under /docs.",
        )
    )
    return "\n".join(lines)


def topic_ids() -> list[str]:
    try:
        return [document["id"] for document in load_operator_guide()["documents"]]
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def render_cli_topic(topic_id: str) -> str:
    """Format one component page from the shared catalog."""
    guide = load_operator_guide()
    document = next(
        (document for document in guide["documents"] if document["id"] == topic_id),
        None,
    )
    if document is None:
        valid = ", ".join(document["id"] for document in guide["documents"])
        raise ValueError(f"unknown help topic {topic_id!r} (choose from: {valid})")

    lines = [document["title"].upper(), document["area"], document["summary"]]
    for section in document["sections"]:
        lines.extend(("", section["title"].upper(), section["description"]))
        for item in section["items"]:
            lines.extend((f"  {item['title']}", f"    {item['body']}"))
            if command := item.get("command"):
                lines.extend(f"    $ {line}" for line in command.splitlines())
            if path := item.get("path"):
                lines.append(f"    {path}")
    return "\n".join(lines)
