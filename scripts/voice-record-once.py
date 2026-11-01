#!/usr/bin/env python3

import argparse
import json
import os
import sys
from pathlib import Path

from voice_audio_common import make_temp_wav, record_audio, trim


def parse_args():
    parser = argparse.ArgumentParser(description="Record one microphone clip with ffmpeg")
    parser.add_argument("--duration-seconds", type=float, default=6.0)
    parser.add_argument("--input-backend", default="")
    parser.add_argument("--input-source", default="")
    parser.add_argument("--output-path", default="")
    return parser.parse_args()


def main():
    args = parse_args()
    output_path = trim(args.output_path)
    if not output_path:
        output_path = make_temp_wav("voice-capture-")
    output_path = str(Path(output_path).expanduser().resolve())

    record_audio(
        output_path,
        duration_seconds=args.duration_seconds,
        backend=args.input_backend,
        source=args.input_source,
    )

    payload = {
        "audioPath": output_path,
    }
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()

