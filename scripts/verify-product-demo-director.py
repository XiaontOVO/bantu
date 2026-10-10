"""Verify the final encoded director cut, never just its render previews.

Decodes every frame and the audio stream, checks the edit decision list/SRT,
extracts final encoded inputs/results for human review, and compares those
images to the exact source composition. No product server/model calls occur.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import re
import subprocess
import sys
from pathlib import Path

ROOT=Path(__file__).resolve().parent.parent
sys.path.insert(0,str(ROOT/"tmp/video-runtime"))
import imageio_ffmpeg
import numpy as np
from PIL import Image, ImageDraw, ImageFont

if hasattr(sys.stdout,"reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

OUT=ROOT/"tmp/director-demo-video"
FFMPEG=imageio_ffmpeg.get_ffmpeg_exe()


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def seconds(stamp):
    h,m,s,ms=map(int,re.split("[:,]",stamp))
    return h*3600+m*60+s+ms/1000


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--skip-full-decode",action="store_true",help="Only after an unchanged full-decode proof exists")
    args=parser.parse_args()
    proof=json.loads((OUT/"render-proof.json").read_text(encoding="utf-8"))
    video=Path(proof["video"])
    subtitle=Path(proof["subtitle"])
    checks=[]

    def check(label,condition,details=None):
        checks.append({"label":label,"passed":bool(condition),"details":details})
        assert condition,f"{label}: {details}"

    check("encoded MP4 exists and matches rendering digest",video.exists() and sha(video)==proof["sha256"],{"bytes":video.stat().st_size,"sha256":sha(video)})
    check("old detailed movie was preserved",sha(proof["oldCompleteFilmPreserved"])==proof["oldCompleteSha256"])
    check("edit file matches encoded movie",sha(proof["editFile"])==proof["editSha256"])
    check("renderer matches encoded movie",sha(ROOT/"scripts/render-product-demo-director.py")==proof["rendererSha256"])
    check("selected operations retain natural speed",proof["shownOperationsNaturalSpeed"] and proof["detailIsSameFrameCrop"])
    check("scope identifies mobile-web source and missing device speech",proof["recordingKind"].startswith("mobile-web") and not proof["capturedWebSpeech"] and proof["simulatedGpsAndClock"])
    check("failed main and successful independent recap are distinct",proof["sourceRecordingHasOneModelTimeout"] and proof["independentMemoryEditSuccessIsSeparateFromFailedMain"])
    kinds={issue["kind"] for issue in proof.get("qualityIssues",[])}
    check("known real model mistakes remain disclosed",{"tool-argument-recovery","model-reply-state-mismatch"}.issubset(kinds))
    check("successful saved result has its exact snapshot supplement",any(item.get("source")=="agent-context-result" for item in proof["segments"]))
    context_audit=json.loads(Path(proof["detailedContextAudit"]).read_text(encoding="utf-8"))
    saved=context_audit["finalSavedResult"]
    check("new map request actually saved driving roads and forty-five minutes",saved["preferredTransportMode"]=="driving" and saved["roadMode"]=="driving" and saved["endMinutes"]-saved["startMinutes"]==45 and saved["geometryPoints"]==97 and saved["distanceMeters"]==4150 and saved["durationMinutes"]==16)
    check("new result-only recording added no model or state mutation",context_audit["restoredResultOnly"]["modelCalls"]==0 and context_audit["restoredResultOnly"]["planDeepEqualityPassed"] and all(c["passed"] for c in context_audit["restoredResultOnly"]["checks"]))
    for name,source in proof["sources"].items():
        check(f"{name} source isolated, actual model, protected config unchanged",source["isolatedData"] and source["realModel"] and source["protectedConfigurationUnchanged"],source["timeline"])
    check("timeline covers exact encoded frame count",proof["segments"][0]["outFrame"]==0 and sum(s["frames"] for s in proof["segments"])==proof["frames"] and abs(proof["seconds"]-proof["frames"]/30)<1e-8)
    for a,b in zip(proof["segments"],proof["segments"][1:]):
        check(f"edit continuity {a['id']} → {b['id']}",abs(a["outEnd"]-b["outStart"])<1e-8)
    for item in proof["segments"]:
        if item.get("hold"):
            check(f"{item['id']} still disclosed as editorial",item["layout"] in ("hero","closing"))
        else:
            check(f"{item['id']} source time kept at 1×",abs(item["frames"]/30-(item["end"]-item["start"])) <= 1/30+.00001)

    entries=re.split(r"\r?\n\s*\r?\n",subtitle.read_text(encoding="utf-8-sig").strip())
    check("SRT has every caption beat",len(entries)==len(proof["captions"]),len(entries))
    for n,(entry,cue) in enumerate(zip(entries,proof["captions"]),1):
        lines=entry.splitlines()
        match=re.fullmatch(r"(\d\d:\d\d:\d\d,\d\d\d) --> (\d\d:\d\d:\d\d,\d\d\d)",lines[1])
        check(f"subtitle {n} text/time",lines[0]==str(n) and match is not None and "\n".join(lines[2:])==cue["text"] and abs(seconds(match[1])-cue["start"])<.0011 and abs(seconds(match[2])-cue["end"])<.0011)
        check(f"subtitle {n} stays within movie",0<=cue["start"]<cue["end"]<=proof["seconds"]+.001)

    metadata=subprocess.run([FFMPEG,"-hide_banner","-i",str(video)],capture_output=True,text=True,encoding="utf-8",errors="replace").stderr
    check("1080p, 30 fps, H264, AAC stereo 48k encoded",bool(re.search(r"Video: h264.*1920x1080.*30 fps",metadata)) and bool(re.search(r"Audio: aac.*48000 Hz, stereo",metadata)),metadata)
    duration=re.search(r"Duration:\s*(\d+):(\d+):([\d.]+)",metadata)
    check("container duration agrees with edit",duration is not None and abs(int(duration[1])*3600+int(duration[2])*60+float(duration[3])-proof["seconds"])<.08)

    decode_path=OUT/"verify-full-decode.json"
    if args.skip_full_decode:
        decode=json.loads(decode_path.read_text(encoding="utf-8"))
        check("unchanged full-decode proof reused",decode["sha256"]==sha(video) and decode["passed"])
    else:
        print(json.dumps({"stage":"full encoded video/audio decode","seconds":proof["seconds"]}),flush=True)
        decoded=subprocess.run([FFMPEG,"-hide_banner","-i",str(video),"-map","0:v:0","-map","0:a:0","-vf","showinfo","-af","volumedetect","-f","null","-"],capture_output=True,text=True,encoding="utf-8",errors="replace")
        (OUT/"verify-full-decode.log").write_text(decoded.stderr,encoding="utf-8")
        values=re.findall(r"\bn:\s*(\d+)\s+pts:\s*\d+\s+pts_time:([\d.]+)",decoded.stderr)
        numbers=[int(n) for n,t in values]
        timestamps=[float(t) for n,t in values]
        mean=re.search(r"mean_volume: ([\-\d.]+) dB",decoded.stderr)
        peak=re.search(r"max_volume: ([\-\d.]+) dB",decoded.stderr)
        check("all encoded frames decode with uninterrupted order",decoded.returncode==0 and numbers==list(range(proof["frames"])),{"decoded":len(numbers),"expected":proof["frames"]})
        check("every encoded frame timestamp is 30 fps",all(abs(t-n/30)<.005 for n,t in zip(numbers,timestamps)))
        check("no decoding/corruption warning",not re.search(r"corrupt|Invalid data|Error while decoding|concealing \d+",decoded.stderr,re.I))
        check("complete audio decoded without clipping",mean is not None and peak is not None and -33<float(mean[1])<-13 and float(peak[1])<-1,{"meanDbfs":float(mean[1]),"peakDbfs":float(peak[1])})
        decode={"passed":True,"sha256":sha(video),"frames":len(numbers),"seconds":proof["seconds"],"meanDbfs":float(mean[1]),"peakDbfs":float(peak[1])}
        decode_path.write_text(json.dumps(decode,ensure_ascii=False,indent=2),encoding="utf-8")

    spec=importlib.util.spec_from_file_location("director_renderer",ROOT/"scripts/render-product-demo-director.py")
    renderer=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(renderer)
    director=renderer.Director(Path(proof["editFile"]))
    selections=[]
    for item in proof["segments"]:
        duration=item["outEnd"]-item["outStart"]
        times=[("main",item.get("preview",min(4,duration*.65)))]
        if not item.get("hold") and duration>18:
            times += [("input",min(6,duration*.25)),("result",max(0,duration-2.5))]
        for number,shot in enumerate(item.get("shots",[])):
            times.append((f"focus{number}",(shot["start"]+shot["end"])/2))
        for kind,t in times:
            index=min(proof["frames"]-1,max(0,round((item["outStart"]+t)*30)))
            selections.append({"label":item["id"]+"-"+kind,"frame":index,"seconds":index/30,"segment":item["id"],"source":item.get("source","complete"),"sourceTime":item["start"] if item.get("hold") else item["start"]+index/30-item["outStart"]})
    unique=sorted(set(item["frame"] for item in selections))
    expression="+".join(f"eq(n,{n})" for n in unique)
    subprocess.run([FFMPEG,"-y","-hide_banner","-v","error","-i",str(video),"-vf",f"select='{expression}'","-vsync","0",str(OUT/"encoded-%04d.png")],check=True)
    by_index={index:OUT/f"encoded-{number:04d}.png" for number,index in enumerate(unique,1)}
    cache={}
    comparisons=[]
    for selection in selections:
        path=by_index[selection["frame"]]
        actual=Image.open(path).convert("RGB")
        expected=director.compose(selection["frame"],cache)
        delta=np.asarray(actual,dtype="float32")-np.asarray(expected,dtype="float32")
        mse=float(np.mean(delta*delta))
        psnr=10*math.log10(255*255/max(mse,1e-9))
        mae=float(np.mean(np.abs(delta)))
        check(f"actual encoded frame matches real composition {selection['label']}",psnr>33 and mae<2.7,{"psnrDb":round(psnr,3),"meanAbsolutePixelDifference":round(mae,3)})
        selection["path"]=str(path)
        comparisons.append({"label":selection["label"],"psnrDb":psnr,"meanAbsolutePixelDifference":mae})

    # A readable review sheet is only a convenience. The original 1080p
    # extracted frames remain available and must be inspected for final QA.
    mainframes=[s for s in selections if s["label"].endswith("-main")]
    cols=2;thumb_width=768;thumb_height=432;label_height=47
    sheet=Image.new("RGB",(cols*thumb_width,math.ceil(len(mainframes)/cols)*(thumb_height+label_height)),"#edf2fc")
    d=ImageDraw.Draw(sheet)
    face=ImageFont.truetype("C:/Windows/Fonts/msyh.ttc",22)
    for n,selection in enumerate(mainframes):
        x=(n%cols)*thumb_width;y=(n//cols)*(thumb_height+label_height)
        sheet.paste(Image.open(selection["path"]).resize((thumb_width,thumb_height),Image.Resampling.LANCZOS),(x,y))
        d.text((x+14,y+thumb_height+10),f"{selection['label']} · {selection['seconds']:.2f}s",font=face,fill="#334660")
    sheet.save(OUT/"verify-encoded-contact-sheet.png")

    audio_samples=[]
    for item in proof["segments"]:
        start=item["outStart"]+min(3,(item["outEnd"]-item["outStart"])*.3)
        length=min(4,item["outEnd"]-start)
        if length<1:
            continue
        pcm=subprocess.run([FFMPEG,"-hide_banner","-v","error","-ss",str(start),"-i",str(video),"-t",str(length),"-vn","-ac","1","-ar","48000","-f","f32le","pipe:1"],capture_output=True)
        samples=np.frombuffer(pcm.stdout,dtype="float32")
        rms=20*math.log10(max(float(np.sqrt(np.mean(samples*samples))),1e-12))
        sample_peak=20*math.log10(max(float(np.max(np.abs(samples))),1e-12))
        check(f"audible music in {item['id']}",pcm.returncode==0 and len(samples)>48000 and -43<rms<-10 and sample_peak<-1,{"rmsDbfs":rms,"peakDbfs":sample_peak})
        audio_samples.append({"segment":item["id"],"start":start,"seconds":length,"rmsDbfs":rms,"peakDbfs":sample_peak})
    report={"passed":True,"video":str(video),"sha256":sha(video),"bytes":video.stat().st_size,"seconds":proof["seconds"],"width":1920,"height":1080,"fps":30,"decodedFrames":decode["frames"],"audioMeanRmsDbfs":decode["meanDbfs"],"audioSamplePeakDbfs":decode["peakDbfs"],"subtitleEntries":len(entries),"encodedFrames":selections,"sourceCompositionComparisons":comparisons,"audioSamples":audio_samples,"actualSceneAudio":proof["actualSceneAudio"],"checks":checks,"visualReviewPending":True}
    (OUT/"verify-proof.json").write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding="utf-8")
    print(json.dumps({"passed":True,"checks":len(checks),"seconds":proof["seconds"],"encodedFrames":len(selections),"contactSheet":str(OUT/"verify-encoded-contact-sheet.png"),"sha256":sha(video)},ensure_ascii=False),flush=True)


if __name__=="__main__":
    main()
