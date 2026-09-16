"""Offline CPU measurements using the existing small-ASR runtime, without transcription."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import time

from faster_whisper.audio import decode_audio
from faster_whisper.vad import VadOptions, get_speech_timestamps


def summarise(intervals, samples, rate=16000):
    previous = 0
    speech = 0
    pauses = []
    for index, span in enumerate(intervals):
        start, end = int(span["start"]), int(span["end"])
        if start < previous or end <= start or end > samples:
            raise ValueError("invalid_activity_intervals")
        if index and start - previous >= 2 * rate:
            pauses.append(start - previous)
        speech += end - start
        previous = end
    return {
        "version": "silero-activity-v1",
        "durationMs": round(samples * 1000 / rate),
        "voicedMs": round(speech * 1000 / rate),
        "longPauseMs": round(sum(pauses) * 1000 / rate),
        "longPauseCount": len(pauses),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("inputs", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("ids", nargs="*")
    args = parser.parse_args()
    args.output.mkdir(mode=0o700, parents=True, exist_ok=True)
    options = VadOptions(threshold=0.5, min_speech_duration_ms=250,
                         min_silence_duration_ms=400, speech_pad_ms=0)
    for source in sorted(args.inputs.iterdir()):
        if source.suffix not in (".wav", ".mp3", ".m4a") or (args.ids and source.stem not in args.ids):
            continue
        target = args.output / (source.stem + ".json")
        if target.exists():
            continue
        started = time.monotonic()
        digest = hashlib.sha256()
        with source.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        if digest.hexdigest() != source.stem:
            raise ValueError("source_hash_mismatch")
        audio = decode_audio(str(source), sampling_rate=16000)
        intervals = get_speech_timestamps(audio, options, sampling_rate=16000)
        result = {"sourceId": source.stem, "facts": summarise(intervals, len(audio)),
                  "intervals": intervals}
        with os.fdopen(os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as stream:
            json.dump(result, stream)
        print(json.dumps({"id": source.stem[:8], **result["facts"],
                          "elapsedSeconds": round(time.monotonic() - started, 2)}), flush=True)


if __name__ == "__main__":
    main()
