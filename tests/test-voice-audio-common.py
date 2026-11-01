#!/usr/bin/env python3

import sys
from pathlib import Path

repo_root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(repo_root / "scripts"))

import voice_audio_common as voice_audio_common


class FakeDefault:
    def __init__(self, device):
        self.device = device


class FakeSounddevice:
    def __init__(self, devices, default_device):
        self._devices = devices
        self._hostapis = [{"name": "Core Audio"}]
        self.default = FakeDefault(default_device)
        self.checked = []

    def query_devices(self):
        return list(self._devices)

    def query_hostapis(self):
        return list(self._hostapis)

    def check_input_settings(self, device=None, channels=None, dtype=None):
        self.checked.append((device, channels, dtype))


original_sd = voice_audio_common.sd

try:
    fallback_sd = FakeSounddevice([
        {"name": "Monitor", "max_input_channels": 0, "max_output_channels": 2, "default_samplerate": 48000.0, "hostapi": 0},
        {"name": "Headphones", "max_input_channels": 0, "max_output_channels": 2, "default_samplerate": 48000.0, "hostapi": 0},
        {"name": "USB Mic", "max_input_channels": 1, "max_output_channels": 0, "default_samplerate": 48000.0, "hostapi": 0},
    ], [-1, 1])
    voice_audio_common.sd = fallback_sd

    fallback_probe = voice_audio_common.probe_sounddevice_input()
    assert fallback_probe["ok"] is True
    assert fallback_probe["selectedDevice"]["index"] == 2
    assert voice_audio_common.resolve_sounddevice_device() == 2
    assert fallback_sd.checked[-1][0] == 2

    named_probe = voice_audio_common.probe_sounddevice_input("usb")
    assert named_probe["ok"] is True
    assert named_probe["selectedDevice"]["index"] == 2

    empty_sd = FakeSounddevice([
        {"name": "Monitor", "max_input_channels": 0, "max_output_channels": 2, "default_samplerate": 48000.0, "hostapi": 0},
    ], [-1, 0])
    voice_audio_common.sd = empty_sd

    no_input_probe = voice_audio_common.probe_sounddevice_input()
    assert no_input_probe["ok"] is False
    assert "Default input is -1" in no_input_probe["error"]
    assert "Monitor" in no_input_probe["error"]

    try:
        voice_audio_common.resolve_sounddevice_device()
    except voice_audio_common.SounddeviceInputUnavailableError as error:
        assert "Default input is -1" in str(error)
    else:
        raise AssertionError("expected SounddeviceInputUnavailableError when no input device is visible")
finally:
    voice_audio_common.sd = original_sd

print("test-voice-audio-common: ok")
