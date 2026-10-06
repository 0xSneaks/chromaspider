"""Runs the UI animation helper tests (tests/js) under Node when it is installed."""

import shutil
import subprocess
from pathlib import Path

import pytest

JS_TESTS = sorted((Path(__file__).parent / "js").glob("*.test.js"))


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_viz_helpers_under_node():
    r = subprocess.run(["node", "--test", *map(str, JS_TESTS)], capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stdout + r.stderr
