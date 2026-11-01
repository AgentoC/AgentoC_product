#!/usr/bin/env python3
r"""Capture a conservative five-second approval-card visibility bound.

Run only after the phone, Windows Host, and Broker QA target have been handed
over for one fresh request. The proposal command must be a fixed, pre-reviewed
QA entrypoint that returns promptly after creating that one request. This tool
does not decide PASS: a reviewer must inspect the pre-proposal baseline and
the PNGs, then confirm the exact request ID in the app's later UI details.
The proposal executable must be a synchronous, direct child process; it must
not daemonize or leave an untracked child. A timeout leaves Broker outcome
UNKNOWN_NO_RETRY and requires a separate status check before any new proposal.

Example (replace paths and fixture arguments with the reviewed QA entrypoint):
  python scripts/measure-android-broker-card-5s.py --adb C:/Android/adb.exe \
    --serial SERIAL --candidate-apk C:/candidate/app-debug.apk \
    --pc-manifest C:/candidate/release.json --handoff-ref handoff-001 \
    --request-id req-unique-001 --out-dir C:/private-evidence/approval-001 \
    --proposal-exe "C:/Program Files/nodejs/node.exe" \
    --proposal-arg C:/qa/propose-once.mjs --proposal-arg req-unique-001
"""

import argparse
import hashlib
import json
import re
import subprocess
import threading
import time
from pathlib import Path

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
MAX_CAPTURE_NS = 7_000_000_000
PROPOSAL_DEADLINE_NS = 10_000_000_000
MAX_FRAMES = 20


def file_sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def absolute_existing_file(value, label):
    path = Path(value)
    if not path.is_absolute() or not path.is_file():
        raise ValueError(f"{label} must be an existing absolute file")
    return path


def capture_png(adb, serial, output):
    started_ns = time.monotonic_ns()
    try:
        with output.open("wb") as image:
            result = subprocess.run(
                [str(adb), "-s", serial, "exec-out", "screencap", "-p"],
                stdin=subprocess.DEVNULL,
                stdout=image,
                stderr=subprocess.DEVNULL,
                timeout=3,
                check=False,
            )
        finished_ns = time.monotonic_ns()
        with output.open("rb") as image:
            valid = result.returncode == 0 and image.read(8) == PNG_MAGIC
        if not valid:
            output.unlink(missing_ok=True)
        return started_ns, finished_ns, valid
    except (OSError, subprocess.TimeoutExpired):
        finished_ns = time.monotonic_ns()
        output.unlink(missing_ok=True)
        return started_ns, finished_ns, False


def finish_proposal(process, started_ns, deadline_ns=PROPOSAL_DEADLINE_NS):
    """Reap only the exact Popen child handle within a bounded total deadline."""
    remaining_s = max(0.0, (started_ns + deadline_ns - time.monotonic_ns()) / 1_000_000_000)
    try:
        return "exited", process.wait(timeout=remaining_s)
    except subprocess.TimeoutExpired:
        pass
    # Popen.terminate/kill operate on this child process handle on Windows,
    # not a PID lookup or the Windows Broker/QA target service.
    try:
        process.terminate()
    except OSError:
        code = process.poll()
        return ("exited", code) if code is not None else ("termination_unconfirmed", None)
    try:
        return "timeout_terminated", process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        try:
            process.kill()
        except OSError:
            code = process.poll()
            return ("timeout_terminated", code) if code is not None else ("termination_unconfirmed", None)
        try:
            return "timeout_killed", process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            return "termination_unconfirmed", process.poll()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--adb", required=True)
    parser.add_argument("--serial", required=True)
    parser.add_argument("--candidate-apk", required=True)
    parser.add_argument("--pc-manifest", required=True)
    parser.add_argument("--handoff-ref", required=True)
    parser.add_argument("--request-id", required=True)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--proposal-exe", required=True)
    parser.add_argument("--proposal-arg", action="append", default=[])
    args = parser.parse_args()

    if not re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", args.request_id):
        parser.error("request-id must be one exact Broker request ID")
    if not re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", args.handoff_ref):
        parser.error("handoff-ref must be a short evidence identifier")
    if not re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", args.serial):
        parser.error("serial must be an exact adb device serial")
    adb = absolute_existing_file(args.adb, "adb")
    proposal = absolute_existing_file(args.proposal_exe, "proposal-exe")
    apk = absolute_existing_file(args.candidate_apk, "candidate-apk")
    manifest = absolute_existing_file(args.pc_manifest, "pc-manifest")
    apk_sha_before = file_sha256(apk)
    manifest_sha_before = file_sha256(manifest)
    out_dir = Path(args.out_dir)
    if not out_dir.is_absolute():
        parser.error("out-dir must be absolute")
    out_dir.mkdir(parents=True, exist_ok=False)

    baseline = out_dir / "baseline.png"
    _, baseline_finished_ns, baseline_ok = capture_png(adb, args.serial, baseline)
    if not baseline_ok:
        raise RuntimeError("baseline capture failed; no proposal was submitted")

    frames = []
    t0_ns = time.monotonic_ns()

    def capture_loop():
        for index in range(MAX_FRAMES):
            if time.monotonic_ns() - t0_ns >= MAX_CAPTURE_NS:
                break
            name = f"frame-{index:02d}.png"
            started_ns, finished_ns, valid = capture_png(adb, args.serial, out_dir / name)
            frames.append({
                "index": index,
                "file": name if valid else None,
                "start_ms": round((started_ns - t0_ns) / 1_000_000, 3),
                "finish_ms": round((finished_ns - t0_ns) / 1_000_000, 3),
                "valid_png": valid,
                "sha256": file_sha256(out_dir / name) if valid else None,
            })

    worker = threading.Thread(target=capture_loop, daemon=False)
    worker.start()
    try:
        process = subprocess.Popen(
            [str(proposal), *args.proposal_arg],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            shell=False,
        )
        launch_status = "started"
    except OSError:
        process = None
        launch_status = "failed"
    worker.join()
    proposal_status, return_code = (
        finish_proposal(process, t0_ns) if process else ("launch_failed", None)
    )
    broker_outcome = "UNVERIFIED" if proposal_status == "exited" and return_code == 0 else "UNKNOWN_NO_RETRY"
    report = {
        "schema_version": 1,
        "verdict": "UNREVIEWED",
        "handoff_ref": args.handoff_ref,
        "request_id": args.request_id,
        "serial": args.serial,
        "candidate_apk_sha256": apk_sha_before,
        "pc_manifest_sha256": manifest_sha_before,
        "artifact_inputs_stable": apk_sha_before == file_sha256(apk)
        and manifest_sha_before == file_sha256(manifest),
        "installed_identity": "UNVERIFIED_REQUIRES_SEPARATE_PHONE_AND_HOST_PROBE",
        "baseline_file": "baseline.png",
        "baseline_sha256": file_sha256(baseline),
        "baseline_finished_before_t0_ms": round((t0_ns - baseline_finished_ns) / 1_000_000, 3),
        "clock": "time.monotonic_ns on the same Windows process",
        "t0_definition": "immediately before launching the one reviewed proposal command",
        "capture_window_ms": MAX_CAPTURE_NS // 1_000_000,
        "proposal_deadline_ms": PROPOSAL_DEADLINE_NS // 1_000_000,
        "proposal_launch": launch_status,
        "proposal_status": proposal_status,
        "proposal_return_code": return_code,
        "proposal_pid": process.pid if process else None,
        "broker_outcome": broker_outcome,
        "frames": frames,
        "review_rule": "Reviewer must open the actual PNGs; PNG magic alone proves no image content. A PNG finished by 5000.000 ms must visibly show the new card and actions; baseline must be empty and later UI details must match request_id.",
    }
    (out_dir / "capture.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "verdict": report["verdict"],
        "capture_json": str(out_dir / "capture.json"),
        "frames": len(frames),
        "proposal_status": proposal_status,
    }))
    valid_run = proposal_status == "exited" and return_code == 0 and report["artifact_inputs_stable"]
    return 0 if valid_run and all(item["valid_png"] for item in frames) else 1


if __name__ == "__main__":
    raise SystemExit(main())
