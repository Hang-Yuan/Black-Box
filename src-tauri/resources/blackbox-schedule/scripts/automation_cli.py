#!/usr/bin/env python3
"""Thin deterministic client for Blackbox's automation command surface."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path


def find_blackbox() -> Path:
    candidates = [
        os.environ.get("BLACKBOX_BIN"),
        "/Applications/Black Box.app/Contents/MacOS/blackbox",
        str(Path.home() / "Applications" / "Black Box.app" / "Contents" / "MacOS" / "blackbox"),
    ]
    for raw in candidates:
        if not raw:
            continue
        path = Path(raw).expanduser()
        if path.is_file() and os.access(path, os.X_OK):
            return path
    raise SystemExit(
        "Blackbox executable not found. Open the installed Black Box app once, "
        "or set BLACKBOX_BIN to its executable path."
    )


def run_tool(arguments: list[str]) -> int:
    command = [str(find_blackbox()), "--automation-tool", *arguments]
    completed = subprocess.run(command, text=True, capture_output=True, check=False)
    if completed.stdout:
        sys.stdout.write(completed.stdout)
    if completed.stderr:
        sys.stderr.write(completed.stderr)
    return completed.returncode


def main() -> int:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("list")
    get_parser = subparsers.add_parser("get")
    get_parser.add_argument("id")
    upsert_parser = subparsers.add_parser("upsert")
    upsert_parser.add_argument("--file", required=True, type=Path)
    for command in ("pause", "resume", "delete", "run"):
        command_parser = subparsers.add_parser(command)
        command_parser.add_argument("id")
    runs_parser = subparsers.add_parser("runs")
    runs_parser.add_argument("id", nargs="?")
    args = parser.parse_args()

    if args.command == "upsert":
        try:
            definition = json.loads(args.file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise SystemExit(f"Invalid automation definition: {error}") from error
        if not isinstance(definition, dict):
            raise SystemExit("Automation definition must be a JSON object")
        # Parse locally before handing the original bytes to Rust. Rust remains
        # the authority for schema, RRULE, project, and read-back validation.
        return run_tool(["upsert", str(args.file.resolve())])
    if args.command == "list":
        return run_tool(["list"])
    if args.command == "runs":
        return run_tool(["runs", *([args.id] if args.id else [])])
    return run_tool([args.command, args.id])


if __name__ == "__main__":
    raise SystemExit(main())
