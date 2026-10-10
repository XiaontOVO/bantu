"""Independently verify the encoded voiced movie and complete audio stems.

Reads only public narration, media and their proofs. It never imports the
product, opens a user store, calls TTS or rewrites the original director proof.
Actual listening is a separate human review; numeric checks do not claim it.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import subprocess
import sys
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tmp/video-runtime"))
import imageio_ffmpeg
import numpy as np

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
OUT = ROOT / "tmp/director-voiceover"
CONFIG = ROOT / "scripts/product-demo-voiceover.json"
SOURCE = ROOT / "submission/伴途产品演示-导演剪辑版.mp4"
VIDEO = ROOT / "submission/伴途产品演示-中文配音版.mp4"
SUBTITLE = ROOT / "submission/伴途产品演示-导演剪辑版.srt"
SOURCE_SHA = "cc571c7ed819ac6bf82c1aaedd2150d0ba9b64ba467fb6469e1bdca6a9d88084"
SUBTITLE_SHA = "2296d98f84178eae10f6766a76adfd22bef0488304b847f30dcc2d1ba98866aa"
SR, SECONDS, FRAMES = 48000, 422.9, 12687
SAMPLES = 20299200


def sha(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def ffmpeg(*args):
    return subprocess.run([FFMPEG, "-hide_banner", "-nostdin", *map(str, args)],
                          capture_output=True)


def decode(path, channels):
    result = ffmpeg("-v", "error", "-i", path, "-vn", "-ar", SR, "-ac", channels,
                    "-f", "f32le", "-")
    if result.returncode:
        raise RuntimeError(result.stderr.decode("utf-8", errors="replace"))
    return np.frombuffer(result.stdout, dtype="<f4").copy().reshape(-1, channels)


def stamp_seconds(stamp):
    h, m, s, ms = map(int, re.split("[:,]", stamp))
    return h * 3600 + m * 60 + s + ms / 1000


def stream_hash(path):
    result = ffmpeg("-v", "error", "-i", path, "-map", "0:v:0", "-c", "copy",
                    "-f", "streamhash", "-hash", "sha256", "-")
    if result.returncode:
        raise RuntimeError(result.stderr.decode("utf-8", errors="replace"))
    match = re.search(r"0,v,SHA256=([0-9a-f]{64})", result.stdout.decode("ascii"))
    if not match:
        raise RuntimeError("Missing copied-video streamhash")
    return match[1]


def db_rms(samples):
    return 20 * math.log10(max(float(np.sqrt(np.mean(samples.astype("float64") ** 2))), 1e-12))


def validate():
    OUT.mkdir(parents=True, exist_ok=True)
    report = {"passed": False, "video": str(VIDEO), "checks": [],
              "audioHumanListeningPerformed": False,
              "audioHumanListeningNote": "Numeric verification only; no human listening pass is claimed.",
              "narrationDefinition": "后期 AI 中文旁白，不是产品设备 TTS 录音"}

    def check(label, condition, details=None):
        report["checks"].append({"label": label, "passed": bool(condition), "details": details})
        if not condition:
            raise AssertionError(f"{label}: {details}")

    def wav_matches(path, expected, channels):
        # Compare every sample in blocks, including all quiet tails. The encoder
        # writes rounded int16 using 32767; allow only that quantization error.
        maximum_error, energy, count = 0.0, 0.0, 0
        with wave.open(str(path), "rb") as stream:
            check(f"{path.name} complete PCM format/time", stream.getframerate() == SR
                  and stream.getnchannels() == channels and stream.getsampwidth() == 2
                  and stream.getnframes() == SAMPLES,
                  {"rate": stream.getframerate(), "channels": stream.getnchannels(),
                   "bits": stream.getsampwidth() * 8, "frames": stream.getnframes()})
            while count < SAMPLES:
                length = min(SR * 5, SAMPLES - count)
                data = np.frombuffer(stream.readframes(length), dtype="<i2").reshape(-1, channels)
                actual = data.astype("float32") / 32767
                target = expected(count, count + length)
                maximum_error = max(maximum_error, float(np.max(np.abs(actual - target))))
                energy += float(np.sum(actual.astype("float64") ** 2))
                count += len(actual)
            check(f"{path.name} every sample retains expected content", count == SAMPLES
                  and maximum_error < 1.6e-5, {"maximumPcmError": maximum_error})
        return {"path": str(path), "sha256": sha(path), "samples": count,
                "maximumPcmError": maximum_error,
                "rmsDbfs": 10 * math.log10(max(energy / (count * channels), 1e-24))}

    try:
        required = [CONFIG, SOURCE, VIDEO, SUBTITLE, OUT / "synthesis-proof.json",
                    OUT / "mix-proof.json", OUT / "narration.wav", OUT / "ducked-music.wav",
                    OUT / "mixed.wav", ROOT / "tmp/director-demo-video/render-proof.json"]
        missing = [str(path) for path in required if not path.is_file()]
        check("all media and verification inputs exist", not missing, {"missing": missing})
        config = read_json(CONFIG)
        synthesis = read_json(OUT / "synthesis-proof.json")
        mix = read_json(OUT / "mix-proof.json")
        original = read_json(ROOT / "tmp/director-demo-video/render-proof.json")
        config_digest = sha(CONFIG)
        report.update({"sha256": sha(VIDEO), "sourceSha256": sha(SOURCE),
                       "publicNarrationConfig": str(CONFIG), "publicNarrationSha256": config_digest,
                       "bytes": VIDEO.stat().st_size})
        check("reviewed original director movie unchanged", sha(SOURCE) == SOURCE_SHA
              and mix["sourceSha256"] == SOURCE_SHA)
        check("mixed output digest agrees with output proof", sha(VIDEO) == mix["sha256"])
        check("movie timeline remains exactly 422.9 seconds", config["sourceVideoSeconds"] == SECONDS
              and mix["seconds"] == SECONDS and mix["samples"] == SAMPLES)

        entries = re.split(r"\r?\n\s*\r?\n", SUBTITLE.read_text(encoding="utf-8-sig").strip())
        check("original 57-entry subtitles remain byte-identical", sha(SUBTITLE) == SUBTITLE_SHA
              and len(entries) == 57 and len(original["captions"]) == 57,
              {"sha256": sha(SUBTITLE), "entries": len(entries)})
        for number, (entry, cue) in enumerate(zip(entries, original["captions"]), 1):
            lines = entry.splitlines()
            time = re.fullmatch(r"(\d\d:\d\d:\d\d,\d\d\d) --> (\d\d:\d\d:\d\d,\d\d\d)", lines[1])
            check(f"original subtitle {number} text and times retained", lines[0] == str(number)
                  and time is not None and "\n".join(lines[2:]) == cue["text"]
                  and abs(stamp_seconds(time[1]) - cue["start"]) < .0011
                  and abs(stamp_seconds(time[2]) - cue["end"]) < .0011)

        configured, synthesized, mixed = config["segments"], synthesis["cues"], mix["cues"]
        check("all 32 complete public narration cues represented", len(configured) == 32
              and len(synthesized) == len(mixed) == 32
              and len({cue["id"] for cue in configured}) == 32
              and all(cue["text"].strip() and "purpose" in cue for cue in configured))
        check("complete source cue files retained without tempo changes", synthesis["allFit"]
              and mix["entireCueFilesKept"] and not mix["tempoAltered"]
              and synthesis["publicTextOnly"] and mix["originalAudioIsMusicInput"])
        check("voice selected consistently", synthesis["voice"] == config["voice"])
        narration = np.zeros(SAMPLES, dtype="float32")
        envelope = np.ones(SAMPLES, dtype="float32")
        previous_end = 0
        cue_results = []
        for number, (spec, syn, item) in enumerate(zip(configured, synthesized, mixed), 1):
            cue_path = ROOT / syn["path"]
            check(f"cue {number} complete public text/times match both proofs", all(spec[key] == syn[key] == item[key]
                  for key in ("id", "text", "start", "end"))
                  and 0 <= spec["start"] < spec["end"] <= SECONDS
                  and syn["voice"] == config["voice"]
                  and syn["rate"] == spec.get("rate", config["rate"]))
            check(f"cue {number} recorded audio digest intact", cue_path.is_file()
                  and sha(cue_path) == syn["sha256"] == item["sha256"])
            request = read_json(cue_path.with_suffix(".request.json"))
            check(f"cue {number} synthesis request matches public wording", request == {
                "text": spec["text"], "voice": config["voice"], "rate": spec.get("rate", config["rate"])})
            pcm = decode(cue_path, 1).ravel()
            start = round(spec["start"] * SR)
            end = start + len(pcm)
            duration, actual_end = len(pcm) / SR, spec["start"] + len(pcm) / SR
            check(f"cue {number} decoded complete and fits its assigned window", len(pcm) == syn["samples"] == item["samples"]
                  and abs(duration - syn["seconds"]) < 1 / SR
                  and abs(actual_end - syn["actualEnd"]) < 1 / SR
                  and syn["fits"] and item["fits"] and actual_end <= spec["end"] - .12
                  and end < SAMPLES, {"duration": duration, "actualEnd": actual_end,
                                      "windowEnd": spec["end"], "samples": len(pcm)})
            check(f"cue {number} separated without overlap", start >= previous_end + round(.3 * SR),
                  {"gapSeconds": (start - previous_end) / SR})
            active = np.flatnonzero(np.abs(pcm) > .006)
            check(f"cue {number} has audible speech samples", len(active) > SR * .15)
            speech_start, speech_end = start + int(active[0]), start + int(active[-1]) + 1
            gain = float(item["normalizationGain"])
            check(f"cue {number} active speech timing/gain agree with decoded audio", gain > 0
                  and abs(item["speechStart"] - speech_start / SR) < 1 / SR
                  and abs(item["speechEnd"] - speech_end / SR) < 1 / SR)
            narration[start:end] += pcm * gain
            left = max(0, speech_start - round(.3 * SR))
            hold_end = min(SAMPLES, speech_end + round(.15 * SR))
            right = min(SAMPLES, hold_end + round(.9 * SR))
            local = np.ones(right - left, dtype="float32")
            attack = speech_start - left
            if attack:
                local[:attack] = 1 - .68 * (.5 - .5 * np.cos(np.linspace(0, np.pi, attack)))
            local[attack:hold_end-left] = .32
            if right > hold_end:
                local[hold_end-left:] = .32 + .68 * (.5 - .5 * np.cos(np.linspace(0, np.pi, right - hold_end)))
            envelope[left:right] = np.minimum(envelope[left:right], local)
            cue_results.append({"id": spec["id"], "text": spec["text"], "start": spec["start"],
                                "actualEnd": actual_end, "speechEnd": speech_end / SR,
                                "samples": len(pcm), "fits": True,
                                "activeRmsDbfs": db_rms((pcm * gain)[active])})
            previous_end = end
        check("last complete narration file ends before 421 seconds", cue_results[-1]["actualEnd"] < 421,
              {"actualEnd": cue_results[-1]["actualEnd"], "remainingSeconds": SECONDS - cue_results[-1]["actualEnd"]})
        report["narrationCues"] = cue_results
        report["publicNarrationEntries"] = len(cue_results)
        check("smooth ducking gain consistent with proof", abs(float(envelope.min()) - .32) < 1e-6
              and float(envelope.max()) == 1 and float(np.max(np.abs(np.diff(envelope)))) < .0002
              and all(abs(a - b) < 1e-6 for a, b in zip(mix["musicGainRange"], [.32, 1])))
        music = decode(SOURCE, 2)
        original_audio_samples = len(music)
        padded = max(0, SAMPLES - original_audio_samples)
        check("all original audio samples retained with only final clock gap padded", padded / SR < .12
              and mix.get("originalAudioSamples", original_audio_samples) == original_audio_samples
              and abs(mix.get("originalFinalGapPaddedSeconds", padded / SR) - padded / SR) < 1 / SR,
              {"originalSamples": original_audio_samples, "clockSamples": SAMPLES,
               "finalGapPaddedSeconds": padded / SR})
        if padded:
            music = np.pad(music, ((0, padded), (0, 0)))
        else:
            music = music[:SAMPLES]
        report["originalAudioSamples"] = original_audio_samples
        report["originalFinalGapPaddedSeconds"] = padded / SR
        report["stems"] = [wav_matches(OUT / "narration.wav", lambda a, b: narration[a:b, None], 1),
                           wav_matches(OUT / "ducked-music.wav", lambda a, b: music[a:b] * envelope[a:b, None], 2)]
        master = float(mix["masterGain"])
        check("master gain protects peaks without added amplification", 0 < master <= 1)
        report["stems"].append(wav_matches(OUT / "mixed.wav", lambda a, b:
                               (music[a:b] * envelope[a:b, None] + narration[a:b, None]) * master, 2))
        music_intervals = [{"label": "opening", "start": .5, "end": 6},
                           {"label": "closing", "start": 418, "end": SECONDS}]
        music_intervals += [{"label": "scene-" + str(n), "start": cue["start"], "end": cue["end"]}
                            for n, cue in enumerate(original["actualSceneAudio"], 1)]
        music_results = []
        for item in music_intervals:
            a, b = round(item["start"] * SR), round(item["end"] * SR)
            level = db_rms(music[a:b] * envelope[a:b, None] * master)
            check(f"original music audible in {item['label']}", level > -48, {"rmsDbfs": level})
            music_results.append({**item, "duckedRmsDbfs": level})
        report["musicWindows"] = music_results
        # Release the large provenance arrays before full encoded media checks.
        del music, narration, envelope

        source_video_hash, voiced_video_hash = stream_hash(SOURCE), stream_hash(VIDEO)
        check("compressed video payload unchanged", source_video_hash == voiced_video_hash,
              {"source": source_video_hash, "output": voiced_video_hash})
        report["videoStreamSha256"] = voiced_video_hash
        metadata = ffmpeg("-i", VIDEO).stderr.decode("utf-8", errors="replace")
        check("output retains H264 1080p30 and AAC stereo 48 kHz", bool(re.search(r"Video: h264.*1920x1080.*30 fps", metadata))
              and bool(re.search(r"Audio: aac.*48000 Hz, stereo", metadata)))
        duration = re.search(r"Duration:\s*(\d+):(\d+):([\d.]+)", metadata)
        container_duration = int(duration[1]) * 3600 + int(duration[2]) * 60 + float(duration[3]) if duration else -1
        check("encoded movie duration within 80 milliseconds", abs(container_duration - SECONDS) < .08,
              {"seconds": container_duration})
        print(json.dumps({"stage": "full voiced movie video/audio decode", "seconds": SECONDS}), flush=True)
        decoded = ffmpeg("-i", VIDEO, "-map", "0:v:0", "-map", "0:a:0", "-vf", "showinfo",
                         "-af", "volumedetect", "-f", "null", "-")
        log = decoded.stderr.decode("utf-8", errors="replace")
        (OUT / "verify-full-decode.log").write_text(log, encoding="utf-8")
        frames = re.findall(r"\bn:\s*(\d+)\s+pts:\s*\d+\s+pts_time:([\d.]+)", log)
        check("all 12687 encoded frames decode in uninterrupted order", decoded.returncode == 0
              and [int(number) for number, _ in frames] == list(range(FRAMES)),
              {"decoded": len(frames), "expected": FRAMES})
        check("all frame times remain at original 30 fps", all(abs(float(t) - int(n) / 30) < .005 for n, t in frames))
        check("no media decoding or corruption error", not re.search(r"corrupt|Invalid data|Error while decoding|concealing \d+", log, re.I))
        mean, peak = re.search(r"mean_volume: ([\-\d.]+) dB", log), re.search(r"max_volume: ([\-\d.]+) dB", log)
        check("encoded audio is audible and has sample peak headroom", mean is not None and peak is not None
              and -38 < float(mean[1]) < -12 and float(peak[1]) < -1,
              {"meanDbfs": float(mean[1]) if mean else None, "peakDbfs": float(peak[1]) if peak else None})
        loudness = ffmpeg("-i", VIDEO, "-vn", "-af", "loudnorm=I=-18:TP=-1:LRA=7:print_format=json", "-f", "null", "-")
        loud_log = loudness.stderr.decode("utf-8", errors="replace")
        (OUT / "verify-loudness.log").write_text(loud_log, encoding="utf-8")
        found = re.findall(r'\{\s*"input_i".*?\}', loud_log, re.S)
        check("encoded audio loudness and true peak measured", loudness.returncode == 0 and bool(found))
        measured = json.loads(found[-1])
        true_peak = float(measured["input_tp"])
        check("encoded AAC true peak below minus one dBTP", math.isfinite(true_peak) and true_peak < -1,
              {"truePeakDbtp": true_peak})
        report["audio"] = {"codec": "AAC", "sampleRate": SR, "channels": 2,
                           "meanRmsDbfs": float(mean[1]), "samplePeakDbfs": float(peak[1]),
                           "integratedLufs": float(measured["input_i"]), "truePeakDbtp": true_peak,
                           "loudnessRangeLu": float(measured["input_lra"])}
        check("source and public script unchanged during verification", sha(SOURCE) == SOURCE_SHA
              and sha(SUBTITLE) == SUBTITLE_SHA and sha(CONFIG) == config_digest)
        report.update({"passed": True, "seconds": container_duration, "decodedFrames": len(frames),
                       "fps": 30, "resolution": [1920, 1080], "subtitleEntries": len(entries)})
    except Exception as error:
        report["error"] = f"{type(error).__name__}: {error}"
    finally:
        (OUT / "verify-proof.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    summary = {key: report[key] for key in ("passed", "video", "error", "seconds", "decodedFrames", "audio") if key in report}
    summary["checks"] = len(report["checks"])
    summary["proof"] = str(OUT / "verify-proof.json")
    print(json.dumps(summary, ensure_ascii=False), flush=True)
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(validate())
