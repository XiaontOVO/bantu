"""Add Mandarin narration to the reviewed demo, preserving its video stream.

Dependencies stay in tmp/tts-runtime and tmp/video-runtime. Speech synthesis
sends only this public narration to Microsoft Edge's online speech service.
It does not access application configuration, keys, databases or processes.
"""
import argparse
import asyncio
import hashlib
import json
import subprocess
import sys
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tmp/tts-runtime"))
sys.path.insert(0, str(ROOT / "tmp/video-runtime"))
import imageio_ffmpeg
import numpy as np

FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
OUT = ROOT / "tmp/director-voiceover"
CONFIG = ROOT / "scripts/product-demo-voiceover.json"
SOURCE = ROOT / "submission/伴途产品演示-导演剪辑版.mp4"
VIDEO = ROOT / "submission/伴途产品演示-中文配音版.mp4"
SR = 48000


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def run(*args):
    return subprocess.run([FFMPEG, "-hide_banner", "-v", "error", *map(str, args)],
                          check=True, capture_output=True)


def decode(path, channels=1):
    result = run("-i", path, "-vn", "-ar", SR, "-ac", channels,
                 "-f", "f32le", "-")
    return np.frombuffer(result.stdout, dtype="<f4").copy().reshape(-1, channels)


def wav(path, samples):
    samples = np.atleast_2d(samples) if samples.ndim == 0 else samples
    if samples.ndim == 1:
        samples = samples[:, None]
    assert np.max(np.abs(samples)) < 1, "PCM clipping"
    with wave.open(str(path), "wb") as stream:
        stream.setparams((samples.shape[1], 2, SR, len(samples), "NONE", "not compressed"))
        stream.writeframes((samples * 32767).round().astype("<i2").tobytes())


async def synth(text, voice, rate, path):
    import edge_tts
    metadata = []
    for attempt in range(3):
        try:
            with path.open("wb") as media:
                async for chunk in edge_tts.Communicate(text, voice, rate=rate,
                                                       pitch="+0Hz", volume="+0%").stream():
                    if chunk["type"] == "audio":
                        media.write(chunk["data"])
                    elif chunk["type"] in ("WordBoundary", "SentenceBoundary"):
                        metadata.append(chunk)
            assert path.stat().st_size > 1000
            write_json(path.with_suffix(".boundaries.json"), metadata)
            return
        except Exception:
            if attempt == 2:
                raise
            metadata.clear()
            await asyncio.sleep(1 + attempt)


async def audition():
    import edge_tts
    OUT.mkdir(parents=True, exist_ok=True)
    voices = await edge_tts.list_voices()
    selected = [v for v in voices if v["ShortName"] in
                ("zh-CN-XiaoxiaoNeural", "zh-CN-XiaoyiNeural")]
    assert len(selected) == 2
    write_json(OUT / "voice-inventory.json", selected)
    text = "这是伴途，陪你把想去的地方，走成自己的旅程。走到一半，累了也很正常。慢一点，沿途的风景值得好好看。"
    for voice in selected:
        path = OUT / (voice["ShortName"] + "-audition.mp3")
        await synth(text, voice["ShortName"], "-4%", path)
        print(json.dumps({"voice": voice["ShortName"], "seconds": len(decode(path)) / SR,
                          "path": str(path)}, ensure_ascii=False), flush=True)


async def synth_all(config):
    import edge_tts
    available = {v["ShortName"] for v in await edge_tts.list_voices()}
    assert config["voice"] in available
    OUT.mkdir(parents=True, exist_ok=True)
    cues = []
    # Sequential synthesis is predictable and avoids hammering the service.
    for cue in config["segments"]:
        path = OUT / (cue["id"] + ".mp3")
        cache = path.with_suffix(".request.json")
        request = {"text": cue["text"], "voice": config["voice"], "rate": cue.get("rate", config["rate"])}
        if not (path.is_file() and cache.is_file() and
                json.loads(cache.read_text(encoding="utf-8")) == request):
            await synth(request["text"], request["voice"], request["rate"], path)
            write_json(cache, request)
        pcm = decode(path)
        duration = len(pcm) / SR
        fit = cue["start"] + duration <= cue["end"] - .12
        measured = {**cue, "voice": request["voice"], "rate": request["rate"],
                    "path": str(path.relative_to(ROOT)), "sha256": sha(path),
                    "samples": len(pcm), "seconds": duration,
                    "actualEnd": cue["start"] + duration, "fits": fit}
        cues.append(measured)
        print(json.dumps({"cue": cue["id"], "seconds": round(duration, 3),
                          "window": round(cue["end"] - cue["start"], 3), "fits": fit},
                         ensure_ascii=False), flush=True)
    write_json(OUT / "synthesis-proof.json", {"voice": config["voice"], "rate": config["rate"],
               "cues": cues, "allFit": all(c["fits"] for c in cues),
               "publicTextOnly": True, "audioHumanListeningClaim": False})


def mix(config):
    proof = json.loads((OUT / "synthesis-proof.json").read_text(encoding="utf-8"))
    assert proof["allFit"], "Shorten or reposition overlong narration before mixing."
    assert [c["text"] for c in proof["cues"]] == [c["text"] for c in config["segments"]]
    total = round(config["sourceVideoSeconds"] * SR)
    music = decode(SOURCE, 2)
    # The original AAC track ends 95 ms before its video track. Preserve all
    # original samples and pad that existing final gap; never trim content.
    original_samples = len(music)
    assert abs(original_samples - total) <= round(.15 * SR)
    if original_samples < total:
        music = np.pad(music, ((0, total - original_samples), (0, 0)))
    else:
        music = music[:total]
    narration = np.zeros(total, dtype=np.float32)
    envelope = np.ones(total, dtype=np.float32)
    cues = []
    previous_end = 0
    for cue in proof["cues"]:
        pcm = decode(ROOT / cue["path"]).ravel()
        start = round(cue["start"] * SR)
        end = start + len(pcm)
        assert start >= previous_end + round(.3 * SR) and end < total
        assert sha(ROOT / cue["path"]) == cue["sha256"]
        # Keep the entire synthesized file; no tempo change or speech truncation.
        active = np.abs(pcm) > .006
        assert active.any()
        first, last = np.flatnonzero(active)[[0, -1]]
        rms = float(np.sqrt(np.mean(pcm[active].astype(np.float64) ** 2)))
        gain = min(10 ** (-19 / 20) / rms, .72 / float(np.max(np.abs(pcm))))
        narration[start:end] += pcm * gain
        speech_start, speech_end = start + int(first), start + int(last) + 1
        left = max(0, speech_start - round(.3 * SR))
        hold_end = min(total, speech_end + round(.15 * SR))
        right = min(total, hold_end + round(.9 * SR))
        local = np.ones(right - left, dtype=np.float32)
        attack = speech_start - left
        if attack:
            local[:attack] = 1 - .68 * (.5 - .5 * np.cos(np.linspace(0, np.pi, attack)))
        local[attack:hold_end-left] = .32
        release = right - hold_end
        if release:
            local[hold_end-left:] = .32 + .68 * (.5 - .5 * np.cos(np.linspace(0, np.pi, release)))
        envelope[left:right] = np.minimum(envelope[left:right], local)
        cues.append({**cue, "speechStart": speech_start / SR, "speechEnd": speech_end / SR,
                     "normalizationGain": gain, "normalizedActiveRmsDbfs": 20 * np.log10(rms * gain)})
        previous_end = end
    ducked = music * envelope[:, None]
    final = ducked + narration[:, None]
    peak = float(np.max(np.abs(final)))
    master_gain = min(1, 10 ** (-2 / 20) / peak)
    final *= master_gain
    wav(OUT / "narration.wav", narration)
    wav(OUT / "ducked-music.wav", ducked)
    wav(OUT / "mixed.wav", final)
    run("-y", "-i", SOURCE, "-i", OUT / "mixed.wav", "-map", "0:v:0", "-map", "1:a:0",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", SR, "-ac", 2,
        "-t", config["sourceVideoSeconds"], "-movflags", "+faststart", VIDEO)
    # User-facing audition contains the actual opening mix and unchanged music.
    run("-y", "-i", VIDEO, "-vn", "-t", 34, "-c:a", "libmp3lame", "-b:a", "192k",
        OUT / "中文配音试听.mp3")
    write_json(OUT / "mix-proof.json", {
        "sourceSha256": sha(SOURCE), "output": str(VIDEO.relative_to(ROOT)), "sha256": sha(VIDEO),
        "bytes": VIDEO.stat().st_size, "seconds": config["sourceVideoSeconds"], "sampleRate": SR,
        "samples": total, "cues": cues, "entireCueFilesKept": True, "tempoAltered": False,
        "originalAudioIsMusicInput": True, "musicGainRange": [float(envelope.min()), float(envelope.max())],
        "originalAudioSamples": original_samples, "originalFinalGapPaddedSeconds": max(0, total-original_samples)/SR,
        "duckingAttackSeconds": .3, "duckingReleaseSeconds": .9,
        "masterGain": master_gain, "pcmPeakDbfs": 20 * np.log10(peak * master_gain),
        "narrationDefinition": "后期 AI 中文旁白，不是产品设备 TTS 录音",
        "audioHumanListeningClaim": False,
    })
    print(json.dumps({"video": str(VIDEO), "seconds": config["sourceVideoSeconds"],
                      "sha256": sha(VIDEO), "cues": len(cues)}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("audition", "synthesize", "mix"))
    action = parser.parse_args().action
    if action == "audition":
        asyncio.run(audition())
    else:
        config = json.loads(CONFIG.read_text(encoding="utf-8"))
        if action == "synthesize":
            asyncio.run(synth_all(config))
        else:
            mix(config)
