"""A deliberately edited, truthful mobile-product director cut.

The edit decision list always identifies the exact real recording and source
time. Product pixels are read from compositor JPEGs and are never recreated.
Retained operations run at their original speed. Opening/closing stills and
independent examples are labelled separately from the continuous main journey.
Run --preview first; encoding is an explicit separate invocation.
"""
from __future__ import annotations

import argparse
import ast
import bisect
import hashlib
import json
import math
import re
import subprocess
import sys
from collections import OrderedDict
from functools import lru_cache
from io import BytesIO
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tmp/video-runtime"))
import imageio_ffmpeg
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

W, H, FPS = 1920, 1080, 30
OUT = ROOT / "tmp/director-demo-video"
OUT.mkdir(parents=True, exist_ok=True)
VIDEO = ROOT / "submission/伴途产品演示-导演剪辑版.mp4"
SRT = ROOT / "submission/伴途产品演示-导演剪辑版.srt"
DEFAULT_EDIT = ROOT / "scripts/product-demo-director-edit.json"
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
INK = "#243650"
MUTED = "#647694"
BLUE = "#4668e9"
PALE = "#e7edff"
ACT_NAMES = ["想去哪里", "一句话，安排好", "在眼前界面，帮你完成", "让地点活起来", "随心一点，继续旅程", "留下自己的旅行"]


def load_complete():
    """Reuse the old assembler without executing its CLI or output writers."""
    path = ROOT / "scripts/render-product-demo-complete.py"
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    # The existing module predates main guards. Stop at parser assignment;
    # neither its encoder nor its subtitle/proof writers are called here.
    body = []
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "parser" for t in node.targets):
            break
        body.append(node)
    namespace = {"__file__": str(path), "__name__": "_director_source_assembler"}
    exec(compile(ast.Module(body=body, type_ignores=[]), str(path), "exec"), namespace)
    return {
        "frames": namespace["frames"], "times": namespace["times"],
        "touches": namespace["touches"], "duration": namespace["DURATION"],
        "audio": json.loads((ROOT / "tmp/complete-demo-video/render-proof.json").read_text(encoding="utf-8"))["actualSceneAudio"],
        "scope": "2026-10-05 mobile-web compositor recordings; original main plus explicitly independent supplements",
        "timeline": str(ROOT / "tmp/complete-demo-video/render-proof.json"),
        "rawSource": namespace["record"],
    }


def load_recording(directory):
    directory = Path(directory)
    if not directory.is_absolute():
        directory = ROOT / directory
    timeline = json.loads((directory / "timeline.json").read_text(encoding="utf-8"))
    raw = [json.loads(line) for line in (directory / "frames.jsonl").read_text(encoding="utf-8").splitlines()]
    assert raw and all(b["t"] >= a["t"] for a, b in zip(raw, raw[1:]))
    frames = [{**frame, "path": str(directory / "frames" / frame["file"]), "sourceLabel": timeline.get("source", directory.name)} for frame in raw]
    audio = []
    for item in timeline.get("audio", []):
        audio.append({**item, "file": str(directory / item["file"]), "end": item.get("end", item["start"] + media_duration(directory / item["file"]))})
    return {"frames": frames, "times": [f["t"] for f in frames], "touches": timeline.get("touches", []), "duration": timeline["duration"], "audio": audio,
            "timeline": str(directory / "timeline.json"), "scope": timeline.get("source", "real mobile-web recording"), "rawSource": timeline}


@lru_cache(maxsize=32)
def media_duration(path):
    result = subprocess.run([FFMPEG, "-hide_banner", "-i", str(path), "-vn", "-f", "null", "-"], capture_output=True, text=True, encoding="utf-8", errors="replace")
    found = re.findall(r"time=(\d+):(\d+):([\d.]+)", result.stderr)
    assert result.returncode == 0 and found, result.stderr
    return max(int(h)*3600 + int(m)*60 + float(s) for h, m, s in found)


def fonts(size, bold=False):
    return ImageFont.truetype("C:/Windows/Fonts/" + ("Dengb.ttf" if bold else "msyh.ttc"), size)


F = {name: fonts(size, bold) for name, size, bold in [
    ("brand", 34, True), ("small", 21, False), ("act", 25, True),
    ("title", 69, True), ("focusTitle", 48, True), ("body", 31, False),
    ("caption", 35, False), ("label", 24, False), ("hero", 90, True),
    ("scope", 25, False), ("number", 168, True),
]}


@lru_cache(maxsize=512)
def wrap(text, face_name, width):
    face = F[face_name]
    lines, line = [], ""
    for char in text:
        if char == "\n" or face.getlength(line + char) > width:
            lines.append(line)
            line = "" if char == "\n" else char
        else:
            line += char
    if line:
        lines.append(line)
    return lines


yy, xx = np.mgrid[0:H, 0:W]
blue_glow = np.exp(-((xx-1400)**2/760**2 + (yy-350)**2/920**2))
purple_glow = np.exp(-((xx-80)**2/840**2 + (yy-1060)**2/600**2))
pixels = np.zeros((H, W, 3)) + np.array([249, 250, 254])
pixels += blue_glow[:, :, None] * np.array([-17, -12, 0])
pixels += purple_glow[:, :, None] * np.array([-4, -12, -1])
BACKGROUND = Image.fromarray(np.clip(pixels, 0, 255).astype("uint8"))
BRAND_PATH = ROOT / "tmp/bantu-demo-brand.png"
BRAND = Image.open(BRAND_PATH).convert("RGBA").resize((46, 46), Image.Resampling.LANCZOS)


def rounded_paste(canvas, picture, box, cache, key="image", radius=24):
    scale = min((box[2]-box[0])/picture.width, (box[3]-box[1])/picture.height)
    size = round(picture.width*scale), round(picture.height*scale)
    x, y = round((box[0]+box[2]-size[0])/2), round((box[1]+box[3]-size[1])/2)
    geometry = (x, y, size, radius)
    if cache.get(key + "-geometry") != geometry:
        shadow = Image.new("RGBA", (W, H))
        d = ImageDraw.Draw(shadow)
        d.rounded_rectangle((x-3, y+12, x+size[0]+3, y+size[1]+16), radius=radius, fill=(27, 51, 95, 43))
        cache[key+"-shadow"] = shadow.filter(ImageFilter.GaussianBlur(19))
        mask = Image.new("L", size)
        ImageDraw.Draw(mask).rounded_rectangle((0, 0, size[0], size[1]), radius=radius, fill=255)
        cache[key+"-mask"] = mask
        cache[key+"-geometry"] = geometry
    canvas.paste(cache[key+"-shadow"], (0, 0), cache[key+"-shadow"])
    canvas.paste(picture.resize(size, Image.Resampling.LANCZOS), (x, y), cache[key+"-mask"])
    return x, y, scale


def draw_text(d, xy, text, face, width, fill=INK, spacing=14):
    for n, line in enumerate(wrap(text, face, width)):
        d.text((xy[0], xy[1] + n*(F[face].size+spacing)), line, font=F[face], fill=fill)


class Director:
    def __init__(self, edit_path):
        self.edit_path = edit_path
        self.edit = json.loads(edit_path.read_text(encoding="utf-8"))
        assert self.edit["version"] == 1
        self.sources = {"complete": load_complete()}
        for name, directory in self.edit.get("sources", {}).items():
            self.sources[name] = load_recording(directory)
        self.segments = []
        frame_cursor = 0
        for item in self.edit["segments"]:
            item = dict(item)
            source = self.sources[item.get("source", "complete")]
            assert 0 <= item["start"] < source["duration"], item
            if item.get("hold"):
                count = round(item["duration"] * FPS)
            else:
                assert item["end"] > item["start"] and item["end"] <= source["duration"] + .001, item
                count = math.ceil((item["end"]-item["start"])*FPS-1e-8)
            assert count > 0
            item.update({"outFrame": frame_cursor, "frames": count, "outStart": frame_cursor/FPS, "outEnd": (frame_cursor+count)/FPS})
            frame_cursor += count
            self.segments.append(item)
        self.total_frames = frame_cursor
        self.duration = frame_cursor/FPS
        self.starts = [s["outStart"] for s in self.segments]
        self.captions = []
        for item in self.segments:
            for beat in item.get("captions", []):
                begin = item["outStart"] + beat["start"]
                end = min(item["outEnd"], item["outStart"] + beat["end"])
                assert begin < end and beat["text"].strip()
                assert len(wrap(beat["text"], "caption", 1720)) <= 2, beat
                self.captions.append({"start": begin, "end": end, "text": beat["text"], "segment": item["id"]})
        assert all(b["start"] >= a["end"]-.001 for a,b in zip(self.captions,self.captions[1:])), "Overlapping captions"
        self.caption_starts = [c["start"] for c in self.captions]

    def get_source(self, item, local, cache):
        source = self.sources[item.get("source", "complete")]
        original = item["start"] if item.get("hold") else item["start"]+local
        fi = max(0, bisect.bisect_right(source["times"], original)-1)
        key = item.get("source", "complete"), fi
        if cache.get("fi") != key:
            path = source["frames"][fi]["path"]
            payload = Path(path).read_bytes()
            digest = hashlib.sha256(payload).digest()
            variants = cache.setdefault("sources", OrderedDict())
            if digest not in variants:
                variants[digest] = Image.open(BytesIO(payload)).convert("RGB")
                if len(variants) > 48:
                    variants.popitem(last=False)
            cache["sourceImage"] = variants[digest]
            cache["sourceKey"] = digest
            cache["fi"] = key
        return cache["sourceImage"], original, source

    def compose(self, index, cache):
        t = index/FPS
        si = max(0,bisect.bisect_right(self.starts,t)-1)
        item = self.segments[si]
        local = t-item["outStart"]
        picture, original, source = self.get_source(item,local,cache)
        mode = item.get("layout", "phone")
        for change in item.get("shots", []):
            if change["start"] <= local < change["end"]:
                mode = change.get("layout", mode)
                shot = change
                break
        else:
            shot = item
        # Each beat may change its editorial heading as input becomes a saved
        # result. These words live outside the unchanged source viewport.
        display = {**item, **{key: value for key, value in shot.items() if key in ("title", "body", "result", "context")}}
        if picture.width > picture.height and mode not in ("hero","closing"):
            mode="landscape"
        caption_index=max(0,bisect.bisect_right(self.caption_starts,t)-1)
        caption=self.captions[caption_index] if self.captions else None
        if caption and not (caption["start"] <= t < caption["end"]):
            caption=None
        visual_key=(si,mode,cache["sourceKey"],tuple(shot.get("roi",[])),display.get("title"),display.get("body"),display.get("result"),display.get("context"))
        layouts=cache.setdefault("layouts",OrderedDict())
        if visual_key in layouts:
            base, mapping, detail_mapping=layouts[visual_key]
            canvas=base.copy()
        else:
            canvas=BACKGROUND.copy()
            d=ImageDraw.Draw(canvas)
            canvas.paste(BRAND,(77,43),BRAND)
            d.text((141,43),"伴途",font=F["brand"],fill=INK)
            d.text((243,52),"随行 · Agent · 旅行回顾",font=F["small"],fill=MUTED)
            mapping=detail_mapping=None
            if mode == "hero":
                # A truthful source still previews the later scene; the graphic
                # title and disclosure are editorial, outside product pixels.
                crop=picture if picture.width>picture.height else picture.crop((0,picture.height*.23,picture.width,picture.height*.8))
                mapping=rounded_paste(canvas,crop,(839,173,1860,866),cache,"hero",36)
                d=ImageDraw.Draw(canvas)
                d.text((93,218),"城市漫游的",font=F["hero"],fill=INK)
                d.text((93,331),"随行伙伴",font=F["hero"],fill=INK)
                draw_text(d,(99,502),"说出想法，落到安排。\n走到眼前，聊起风景。", "body", 688, spacing=18)
                d.rounded_rectangle((99,658,650,719),radius=30,fill=PALE)
                d.text((124,669),"在当前界面，直接帮你完成",font=F["act"],fill=BLUE)
                d.text((95,848),"跨界面 Agent · 精选演示",font=F["label"],fill=MUTED)
                d.text((879,897),"实际界面片段预览 · AI 艺术场景",font=F["small"],fill=MUTED)
            elif mode == "closing":
                mapping=rounded_paste(canvas,picture,(1260,178,1790,912),cache,"close",27)
                d=ImageDraw.Draw(canvas)
                draw_text(d,(97,221),"随心旅行，\n也能从容往前。","title",1030,spacing=20)
                draw_text(d,(103,483),"发现、安排、参观、调整与回顾，\n都在这一程里。","body",1050,spacing=15)
                d.line((101,645,1150,645),fill="#d8e0ee",width=2)
                draw_text(d,(104,688),"移动网页实录 · 原速操作 · 精选剪辑\n定位与时钟为演示设置，道路使用真实路线服务。\n独立示例已标注；未录入设备语音，未作现场 GPS 验收。", "scope",1090,spacing=12)
            elif mode == "landscape":
                d.text((81,116),display["title"],font=F["focusTitle"],fill=INK)
                d.text((1489,133),"AI 艺术场景",font=F["label"],fill=MUTED)
                mapping=rounded_paste(canvas,picture,(81,211,1839,936),cache,"landscape",27)
            elif mode == "focus":
                act=item.get("act",1)
                d.text((79,121),f"{act:02d}  {ACT_NAMES[act-1]}",font=F["act"],fill=BLUE)
                draw_text(d,(78,180),display["title"],"focusTitle",622,spacing=10)
                mapping=rounded_paste(canvas,picture,(123,336,598,928),cache,"phone-small",23)
                roi=tuple(round(a*b) for a,b in zip(shot.get("roi", [.025,.34,.975,.76]),(picture.width,picture.height,picture.width,picture.height)))
                detail=picture.crop(roi)
                detail_mapping=rounded_paste(canvas,detail,(738,200,1811,906),cache,"detail",24)
                d=ImageDraw.Draw(canvas)
                d.text((744,133),"同一界面 · 看清关键内容",font=F["label"],fill=MUTED)
                # A quiet source-frame locator keeps the enlargement auditable.
                x,y,scale=mapping
                d.rounded_rectangle((x+roi[0]*scale,y+roi[1]*scale,x+roi[2]*scale,y+roi[3]*scale),radius=5,outline="#8ba3f2",width=2)
                detail_mapping=(*detail_mapping,roi)
            else:
                act=item.get("act",1)
                d.text((81,158),f"{act:02d}  {ACT_NAMES[act-1]}",font=F["act"],fill=BLUE)
                draw_text(d,(78,248),display["title"],"title",822,spacing=16)
                draw_text(d,(86,512),display.get("body",""),"body",775,fill=MUTED,spacing=18)
                if display.get("result"):
                    d.line((87,704,728,704),fill="#cbd6ed",width=2)
                    draw_text(d,(88,743),display["result"],"act",764,fill=BLUE,spacing=13)
                mapping=rounded_paste(canvas,picture,(1001,116,1631,946),cache,"phone",29)
            d=ImageDraw.Draw(canvas)
            if mode not in ("hero","closing"):
                # One simple context label; recording constraints live in the
                # opening/end and independent-example bands instead of clutter.
                context=display.get("context", "")
                if context:
                    width=F["small"].getlength(context)+44
                    d.rounded_rectangle((1839-width,49,1839,91),radius=21,fill="white")
                    d.text((1861-width,55),context,font=F["small"],fill=MUTED)
                for n in range(6):
                    x=80+n*21
                    d.ellipse((x,925,x+7,932),fill=BLUE if n==item.get("act",1)-1 else "#cbd6e7")
            if item.get("disclosure"):
                # The band is deliberately editorial and never masks product UI.
                d.text((81,953),item["disclosure"],font=F["small"],fill=MUTED)
            layouts[visual_key]=(canvas.copy(),mapping,detail_mapping)
            if len(layouts)>48:
                layouts.popitem(last=False)
        # Actual touch coordinates only; no synthetic taps or retargeted clicks.
        if mapping and not item.get("hold"):
            d=ImageDraw.Draw(canvas)
            x,y,scale=mapping
            for touch in source["touches"]:
                age=original-touch["t"]
                if 0 <= age < .60:
                    tx,ty=touch["x"]*picture.width,touch["y"]*picture.height
                    r=9+age*13
                    d.ellipse((x+tx*scale-r,y+ty*scale-r,x+tx*scale+r,y+ty*scale+r),outline=BLUE,width=3)
                    if detail_mapping:
                        zx,zy,zscale,roi=detail_mapping
                        if roi[0]<=tx<=roi[2] and roi[1]<=ty<=roi[3]:
                            a,b=zx+(tx-roi[0])*zscale,zy+(ty-roi[1])*zscale
                            d.ellipse((a-r,b-r,a+r,b+r),outline=BLUE,width=3)
        d=ImageDraw.Draw(canvas)
        if caption:
            lines=wrap(caption["text"],"caption",1720)
            sy=993 if len(lines)==1 else 975
            for n,line in enumerate(lines):
                d.text(((W-F["caption"].getlength(line))/2,sy+n*42),line,font=F["caption"],fill=INK)
        return canvas

    def preview(self):
        cache={}
        frames=[]
        for item in self.segments:
            local=item.get("preview",min(4,(item["outEnd"]-item["outStart"])*.65))
            t=item["outStart"]+local
            path=OUT/f"preview-{item['id']}.png"
            self.compose(min(self.total_frames-1,round(t*FPS)),cache).save(path)
            frames.append({"segment":item["id"],"outputTime":t,"source":item.get("source","complete"),"sourceTime":item["start"] if item.get("hold") else item["start"]+local,"path":str(path)})
        self.write_srt()
        self.proof(previews=frames)
        print(json.dumps({"seconds":self.duration,"segments":len(self.segments),"captions":len(self.captions),"previews":frames},ensure_ascii=False),flush=True)

    @staticmethod
    def stamp(value):
        ms=round(value*1000)
        h,ms=divmod(ms,3600000);m,ms=divmod(ms,60000);s,ms=divmod(ms,1000)
        return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"

    def write_srt(self):
        entries=[f"{n}\n{self.stamp(c['start'])} --> {self.stamp(c['end'])}\n{c['text']}\n" for n,c in enumerate(self.captions,1)]
        SRT.write_text("\n".join(entries),encoding="utf-8-sig")

    def map_audio(self):
        windows=[]
        for item in self.segments:
            if item.get("hold"):
                continue
            source=self.sources[item.get("source","complete")]
            for sample in source["audio"]:
                a=max(item["start"],sample["start"])
                b=min(item["end"],sample["end"])
                if b>a+.1:
                    windows.append({"start":item["outStart"]+a-item["start"],"end":item["outStart"]+b-item["start"],"offset":a-sample["start"],"file":sample["file"],"sourceLabel":sample.get("sourceLabel",source["scope"]),"segment":item["id"]})
        return windows

    def encode(self,reuse=False):
        pending=OUT/"director-video-only.mp4"
        if not reuse:
            process=subprocess.Popen([FFMPEG,"-y","-hide_banner","-v","error","-f","rawvideo","-pix_fmt","rgb24","-s",f"{W}x{H}","-r",str(FPS),"-i","pipe:0","-an","-c:v","libx264","-preset","fast","-crf","18","-pix_fmt","yuv420p","-movflags","+faststart",str(pending)],stdin=subprocess.PIPE,stderr=subprocess.PIPE)
            cache={}
            try:
                for i in range(self.total_frames):
                    process.stdin.write(self.compose(i,cache).tobytes())
                    if i%(FPS*15)==0:
                        print(json.dumps({"renderedSeconds":i/FPS,"totalSeconds":self.duration}),flush=True)
                process.stdin.close()
                error=process.stderr.read().decode("utf-8",errors="replace")
                assert process.wait()==0,error
            except BaseException:
                process.kill()
                raise
        assert pending.exists() and pending.stat().st_size>1_000_000
        windows=self.map_audio()
        envelope="0.94"
        # Keep the original score coherent; scene music takes the foreground.
        for sample in reversed(windows):
            a,b=sample["start"],sample["end"]
            begin=max(0,a-1.2)
            envelope=f"if(lt(t,{begin}),{envelope},if(lt(t,{a}),0.12+0.82*({a}-t)/1.2,if(lt(t,{b}),0.12,if(lt(t,{b+1.2}),0.12+0.82*(t-{b})/1.2,{envelope}))))"
        command=[FFMPEG,"-y","-hide_banner","-v","error","-i",str(pending),"-stream_loop","-1","-i",str(ROOT/"submission/伴途演示配乐.mp3")]
        filters=[f"[1:a]atrim=duration={self.duration},asetpts=PTS-STARTPTS,volume='{envelope}':eval=frame,afade=t=in:d=1.2,afade=t=out:st={self.duration-3}:d=3[score]"]
        for n,sample in enumerate(windows):
            command += ["-i",str(sample["file"])]
            length=sample["end"]-sample["start"]
            filters.append(f"[{n+2}:a]atrim=start={sample['offset']}:duration={length},asetpts=PTS-STARTPTS,loudnorm=I=-22:TP=-3:LRA=6,afade=t=in:d=0.2,afade=t=out:st={max(0,length-.35)}:d=0.35,adelay={round(sample['start']*1000)}:all=1[scene{n}]")
        inputs="[score]"+"".join(f"[scene{n}]" for n in range(len(windows)))
        filters.append(f"{inputs}amix=inputs={len(windows)+1}:duration=longest:normalize=0,apad,atrim=duration={self.duration},alimiter=limit=.891:level=false[audio]")
        command += ["-filter_complex",";".join(filters),"-map","0:v:0","-map","[audio]","-c:v","copy","-c:a","aac","-b:a","192k","-ar","48000","-t",str(self.duration),"-movflags","+faststart",str(VIDEO)]
        subprocess.run(command,check=True)
        self.write_srt()
        report=self.proof(audio=windows)
        print(json.dumps({k:report[k] for k in ["video","seconds","frames","bytes","sha256"]},ensure_ascii=False),flush=True)

    def proof(self,previews=None,audio=None):
        oldproof=json.loads((ROOT/"tmp/complete-demo-video/render-proof.json").read_text(encoding="utf-8"))
        report={"version":1,"video":str(VIDEO),"subtitle":str(SRT),"editFile":str(self.edit_path),"editSha256":hashlib.sha256(self.edit_path.read_bytes()).hexdigest(),"rendererSha256":hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),"width":W,"height":H,"fps":FPS,"seconds":self.duration,"frames":self.total_frames,"segments":self.segments,"captions":self.captions,"sources":{name:{"timeline":s["timeline"],"scope":s["scope"],"duration":s["duration"],"sourceFrames":len(s["frames"]),"realModel":s["rawSource"].get("realModel"),"isolatedData":s["rawSource"].get("isolatedData"),"protectedConfigurationUnchanged":s["rawSource"].get("protectedConfigurationUnchanged")} for name,s in self.sources.items()},"shownOperationsNaturalSpeed":True,"editorialStillsLabelled":True,"detailIsSameFrameCrop":True,"capturedWebSpeech":False,"recordingKind":"mobile-web compositor recording; not APK/physical-phone acceptance","simulatedGpsAndClock":True,"oldCompleteFilmPreserved":str(ROOT/"submission/伴途完整产品演示.mp4"),"oldCompleteSha256":hashlib.sha256((ROOT/"submission/伴途完整产品演示.mp4").read_bytes()).hexdigest(),"originalScore":str(ROOT/"submission/伴途演示配乐.mp3"),"actualSceneAudio":audio or self.map_audio(),"mainModelTimeoutOmittedFromSelectedFilm":True,"mainModelTimeoutSeconds":oldproof["mainTimeoutSeconds"],"sourceRecordingHasOneModelTimeout":True,"independentMemoryEditSuccessIsSeparateFromFailedMain":True,"scopeNotes":self.edit.get("scopeNotes",[]),"previews":previews or [],"sha256":hashlib.sha256(VIDEO.read_bytes()).hexdigest() if VIDEO.exists() else None,"bytes":VIDEO.stat().st_size if VIDEO.exists() else None}
        report["qualityIssues"] = self.edit.get("qualityIssues", [])
        for name, source in self.sources.items():
            raw = source["rawSource"]
            report["sources"][name].update({
                "modelCallsIncludingOmittedSourceIntervals": raw.get("modelCalls", 0),
                "independentSetup": raw.get("independentSetup"),
                "sourceChecks": raw.get("checks", []),
                "roadProvider": raw.get("roadProvider", raw.get("realRoadProvider")),
                "simulatedRoads": raw.get("simulatedRoads"),
            })
        report["detailedContextAudit"] = str(ROOT / "tmp/agent-context-demo-review.json")
        report["waitCuts"] = [
            {"source":"complete", "start":111.5, "end":132, "omittedSeconds":20.5, "actualRequestSeconds":28.10},
            {"source":"agent-context", "start":30.5, "end":48, "omittedSeconds":17.5, "actualRequestSeconds":35.13},
            {"source":"agent-context", "start":113.5, "end":125.5, "omittedSeconds":12, "actualRequestSeconds":23.86},
            {"source":"complete", "start":289, "end":298.3, "omittedSeconds":9.3, "actualRequestSeconds":13.98},
        ]
        (OUT/"render-proof.json").write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding="utf-8")
        return report


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--edit",type=Path,default=DEFAULT_EDIT)
    parser.add_argument("--preview",action="store_true")
    parser.add_argument("--reuse-render",action="store_true")
    args=parser.parse_args()
    director=Director(args.edit)
    if args.preview:
        director.preview()
    else:
        director.encode(args.reuse_render)


if __name__ == "__main__":
    main()
