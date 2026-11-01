#!/usr/bin/env python3

import argparse

from voice_audio_common import capture_until_silence, emit_json, trim


def parse_args():
    parser = argparse.ArgumentParser(description="Capture one utterance and stop after trailing silence")
    parser.add_argument("--timeout-ms", type=int, default=15000)
    parser.add_argument("--speech-start-timeout-ms", type=int, default=5000)
    parser.add_argument("--silence-ms", type=int, default=900)
    parser.add_argument("--frame-ms", type=int, default=100)
    parser.add_argument("--pre-roll-ms", type=int, default=250)
    parser.add_argument("--speech-threshold", type=float, default=0.0015)
    parser.add_argument("--sample-rate", type=int, default=16000)
    parser.add_argument("--input-backend", default="sounddevice")
    parser.add_argument("--input-source", default="")
    parser.add_argument("--output-path", default="")
    return parser.parse_args()


def main():
    args = parse_args()
    payload = capture_until_silence(
        args.output_path,
        timeout_ms=args.timeout_ms,
        speech_start_timeout_ms=args.speech_start_timeout_ms,
        silence_ms=args.silence_ms,
        frame_ms=args.frame_ms,
        pre_roll_ms=args.pre_roll_ms,
        speech_threshold=args.speech_threshold,
        sample_rate=args.sample_rate,
        backend=trim(args.input_backend) or "sounddevice",
        source=args.input_source,
    )
    emit_json(payload)


if __name__ == "__main__":
    main()
