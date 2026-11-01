"""Offline process-lifecycle check for the phone timing fixture; no ADB or Broker use."""

import importlib.util
import subprocess
import sys
import time
from pathlib import Path


script = Path(__file__).resolve().parents[1] / "scripts" / "measure-android-broker-card-5s.py"
spec = importlib.util.spec_from_file_location("measure_approval_card", script)
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)

with subprocess.Popen(
    [sys.executable, "-B", "-c", "import time; time.sleep(30)"],
    stdin=subprocess.DEVNULL,
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
) as child:
    start = time.monotonic_ns()
    status, code = fixture.finish_proposal(child, start, deadline_ns=50_000_000)
    assert status in {"timeout_terminated", "timeout_killed"}, (status, code)
    assert child.poll() is not None, "the exact spawned child must be reaped"
    assert time.monotonic_ns() - start < 5_000_000_000

with subprocess.Popen(
    [sys.executable, "-B", "-c", "import sys; sys.exit(0)"],
    stdin=subprocess.DEVNULL,
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
) as child:
    status, code = fixture.finish_proposal(child, time.monotonic_ns(), deadline_ns=1_000_000_000)
    assert (status, code) == ("exited", 0)

print("Android Broker five-second capture fixture lifecycle tests passed")
