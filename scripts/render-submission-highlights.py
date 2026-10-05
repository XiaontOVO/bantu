"""Recompose existing browser evidence into a short, faithful 1080p product film.

No new operations or model calls are recorded here. Continuous action clips run
at their recorded speed, including the complete plan-adjustment model wait.
"""
import argparse
import bisect
import hashlib
import json
import math
import re
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tmp/video-runtime'))
import imageio_ffmpeg

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')

W, H, FPS = 1920, 1080, 30
EVIDENCE = ROOT / 'tmp/highlights-evidence'
VIDEO = ROOT / 'submission/伴途作品演示-精华版.mp4'
SUBTITLE = ROOT / 'submission/伴途作品演示-精华版.srt'
ORIGINAL_VIDEO = ROOT / 'submission/伴途功能演示-配乐版.mp4'
ORIGINAL_SHA256 = hashlib.sha256(ORIGINAL_VIDEO.read_bytes()).hexdigest()
EVIDENCE.mkdir(parents=True, exist_ok=True)
record = json.loads((ROOT / 'tmp/product-demo-recording.json').read_text(encoding='utf-8'))
assert record['realModel'] and record['isolatedData'] and not record.get('failed') and not record.get('modelErrors')
directory = Path(record['directory'])
frames = [json.loads(line) for line in (directory / 'frames.jsonl').read_text().splitlines()]
times = [frame['t'] for frame in frames]
assert len(frames) == record['sourceFrames'] and all(b >= a for a, b in zip(times, times[1:]))
ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
FONT_ROOT = Path('C:/Windows/Fonts')


def font(size, bold=False):
    return ImageFont.truetype(str(FONT_ROOT / ('msyhbd.ttc' if bold else 'msyh.ttc')), size)


F = {'brand':font(33, True), 'small':font(21), 'caption':font(34),
     'title':font(38, True), 'intro':font(55, True), 'step':font(24), 'number':font(21, True)}
INK, MUTED, BLUE = '#23334f', '#687b95', '#426af1'
# This is an editorial order. The earlier scene is explicitly introduced as a
# look back, so a completed visit is never portrayed as happening a second time.
segments = [
    {'key':'intro', 'title':'旅途中的变化', 'sourceStart':134.5, 'seconds':4, 'hold':True},
    {'key':'adjust', 'title':'一句话，调整原计划', 'sourceStart':161.9, 'sourceEnd':211.034027},
    {'key':'continue', 'title':'接着这一次旅程', 'sourceStart':211.034027, 'sourceEnd':242.2272318},
    {'key':'scene', 'title':'回看 · 到访时的沉浸探索', 'sourceStart':134.3792857, 'sourceEnd':161.8936258},
    {'key':'memory', 'title':'走过的路，留给自己', 'sourceStart':242.2272318, 'sourceEnd':255.8865538},
    {'key':'outro', 'title':'让计划跟上变化', 'sourceStart':254.9, 'seconds':4, 'hold':True},
]
position = 0
for segment in segments:
    segment['frames'] = round(segment.get('seconds', segment.get('sourceEnd', 0) - segment['sourceStart']) * FPS)
    segment['startFrame'] = position
    segment['outputStart'] = position / FPS
    segment['outputEnd'] = (position + segment['frames']) / FPS
    segment['speed'] = 0 if segment.get('hold') else 1
    position += segment['frames']
TOTAL_FRAMES, DURATION = position, position / FPS
starts = [segment['startFrame'] for segment in segments]
start_for = {segment['key']:segment['outputStart'] for segment in segments}
end_for = {segment['key']:segment['outputEnd'] for segment in segments}

# A continuous Chinese subtitle track is burned in and also supplied as SRT.
caption_breaks = [
    (0, '变化发生在途中，伴途就在当前页面帮你调整。'),
    (start_for['adjust'], '参观时打开伴途小窗，当前页面仍然可以操作。'),
    (start_for['adjust'] + 10.5, '把西岸美术馆的停留，从45分钟改成30分钟。'),
    (start_for['adjust'] + 13, '真实模型正在查询并调用工具，这里保留完整等待过程。'),
    (start_for['adjust'] + 34.5, '收到执行回执：沿用原计划，保留已经发生的进度。'),
    (start_for['adjust'] + 43, '回到首页，接着这一次旅程。'),
    (start_for['continue'], '完成当前站点，再出发去下一站。'),
    (start_for['continue'] + 14, '各次到访分别记录；西岸的停留已经变成30分钟。'),
    (start_for['scene'], '回看这次到访：从武康大楼打开沉浸探索。'),
    (start_for['scene'] + 11, '横屏触摸画里的红砖，文字讲解浮现，地点BGM开始。'),
    (start_for['scene'] + 23, '地点艺术场景用于探索与感受，并非实景影像。'),
    (start_for['memory'], '一天结束，实际足迹连成这一次旅程的私人回顾。'),
    (start_for['memory'] + 6, '走过的地点、到访与完成时间，都留在同一次旅程里。'),
    (start_for['outro'], '伴途，让计划跟上变化，也把走过的路留给自己。'),
]
caption_breaks.sort(key=lambda item:item[0])
caption_times = [item[0] for item in caption_breaks]
assert caption_times[0] == 0 and caption_times[-1] < DURATION

yy, xx = np.mgrid[0:H, 0:W]
cool = np.exp(-((xx - 650) ** 2 / 780 ** 2 + (yy - 380) ** 2 / 730 ** 2))
warm = np.exp(-((xx - 1750) ** 2 / 800 ** 2 + (yy - 700) ** 2 / 920 ** 2))
pixels = np.zeros((H, W, 3), np.float64) + np.array([246, 248, 252])
pixels += cool[:, :, None] * np.array([-14, -9, 1]) + warm[:, :, None] * np.array([6, 1, -9])
background = Image.fromarray(np.clip(pixels, 0, 255).astype('uint8'))
brand = Image.open(ROOT / 'tmp/bantu-demo-brand.png').convert('RGBA').resize((40, 40), Image.Resampling.LANCZOS)


def centered(draw, text, y, face, fill=INK):
    draw.text(((W - face.getlength(text)) / 2, y), text, font=face, fill=fill)


def plate(segment, landscape):
    canvas = background.copy()
    canvas.paste(brand, (62, 21), brand)
    draw = ImageDraw.Draw(canvas)
    draw.text((116, 18), '伴途', font=F['brand'], fill=INK)
    draw.text((220, 29), '让计划跟上变化', font=F['small'], fill=MUTED)
    draw.text((1510, 29), '真实模型 · 浏览器实录', font=F['small'], fill=MUTED)
    draw.line((62, 77, 1858, 77), fill='#dce5f0', width=1)
    if not landscape:
        draw.text((88, 130), segment['title'], font=F['title'], fill=INK)
        if segment['key'] == 'intro':
            draw.text((90, 395), '走在路上，', font=F['intro'], fill=INK)
            draw.text((90, 469), '临时想改计划？', font=F['intro'], fill=INK)
            draw.text((94, 565), '不用离开当前页面，问一句伴途。', font=F['small'], fill=MUTED)
        elif segment['key'] == 'outro':
            draw.text((90, 395), '继续走，', font=F['intro'], fill=INK)
            draw.text((90, 469), '也记得慢慢看。', font=F['intro'], fill=INK)
        else:
            labels = [('adjust', '修改原计划'), ('continue', '接着走'), ('scene', '触摸风景'), ('memory', '留下回顾')]
            for i, (key, label) in enumerate(labels):
                y = 354 + i * 101
                active = segment['key'] == key
                draw.rounded_rectangle((92, y, 127, y + 35), radius=17, fill=BLUE if active else '#e3eaf5')
                draw.text((103, y + 3), str(i + 1), font=F['number'], fill='white' if active else '#8495af')
                draw.text((146, y), label, font=F['step'], fill=INK if active else '#8595ac')
                if i < 3:
                    draw.line((110, y + 44, 110, y + 91), fill='#d5dfed', width=2)
    else:
        draw.text((82, 91), segment['title'], font=F['small'], fill=MUTED)
        draw.text((1540, 91), 'AI 艺术场景 · 非实景', font=F['small'], fill=MUTED)
    draw.line((62, 1052, 1858, 1052), fill='#dde5f0', width=2)
    draw.text((64, 1057), '移动端浏览器既有实录 · 片段重编排 · 定位 / 道路 / 时钟为演示数据', font=font(16), fill=MUTED)
    draw.text((1623, 1057), '1080p · 30fps', font=font(16), fill=MUTED)
    return canvas


def source_for(segment, output_frame):
    elapsed = (output_frame - segment['startFrame']) / FPS
    source_time = segment['sourceStart'] if segment.get('hold') else segment['sourceStart'] + elapsed
    index = max(0, bisect.bisect_right(times, source_time) - 1)
    return index, source_time


def compose(output_frame, cache):
    segment = segments[max(0, bisect.bisect_right(starts, output_frame) - 1)]
    source_index, source_time = source_for(segment, output_frame)
    if source_index != cache.get('sourceIndex'):
        cache['source'] = Image.open(directory / 'frames' / frames[source_index]['file']).convert('RGB')
        cache['sourceIndex'] = source_index
    source = cache['source']
    landscape = source.width > source.height
    key = segment['key'], landscape
    if key != cache.get('plateKey'):
        cache['plate'] = plate(segment, landscape)
        cache['plateKey'] = key
    canvas = cache['plate'].copy()
    # The whole UI remains visible. The portrait is taller than in the long film
    # and centered; landscape art occupies nearly the entire product area.
    box = (78, 128, 1842, 971) if landscape else (618, 92, 1302, 974)
    scale = min((box[2] - box[0]) / source.width, (box[3] - box[1]) / source.height)
    size = round(source.width * scale), round(source.height * scale)
    x, y = round((box[0] + box[2] - size[0]) / 2), round((box[1] + box[3] - size[1]) / 2)
    image = source.resize(size, Image.Resampling.LANCZOS)
    if cache.get('shadowBox') != (x, y, size):
        shadow = Image.new('RGBA', (W, H))
        shadow_draw = ImageDraw.Draw(shadow)
        shadow_draw.rounded_rectangle((x - 5, y + 10, x + size[0] + 5, y + size[1] + 13), radius=25, fill=(38, 56, 95, 39))
        cache['shadow'] = shadow.filter(ImageFilter.GaussianBlur(20))
        cache['shadowBox'] = x, y, size
        mask = Image.new('L', size)
        ImageDraw.Draw(mask).rounded_rectangle((0, 0, size[0], size[1]), radius=18 if not landscape else 13, fill=255)
        cache['mask'] = mask
    canvas.paste(cache['shadow'], (0, 0), cache['shadow'])
    canvas.paste(image, (x, y), cache['mask'])
    draw = ImageDraw.Draw(canvas)
    # Actual touch coordinates only; no invented targets or cursor movements.
    if not segment.get('hold'):
        for touch in record['touches']:
            age = source_time - touch['t']
            if 0 <= age < .7:
                tx, ty, radius = x + touch['x'] * size[0], y + touch['y'] * size[1], 11 + age * 15
                draw.ellipse((tx - radius, ty - radius, tx + radius, ty + radius), outline=BLUE, width=3)
    t = output_frame / FPS
    caption = caption_breaks[max(0, bisect.bisect_right(caption_times, t) - 1)][1]
    assert F['caption'].getlength(caption) < 1740, caption
    centered(draw, caption, 995, F['caption'])
    # Progress is editorial, never confused with the app's visit progress.
    draw.line((62, 1052, 62 + 1796 * t / DURATION, 1052), fill=BLUE, width=2)
    return canvas


def stamp(seconds):
    ms = round(seconds * 1000)
    hours, ms = divmod(ms, 3600000)
    minutes, ms = divmod(ms, 60000)
    seconds, ms = divmod(ms, 1000)
    return f'{hours:02}:{minutes:02}:{seconds:02},{ms:03}'


def write_srt():
    cues = []
    for index, (start, text) in enumerate(caption_breaks):
        end = caption_breaks[index + 1][0] if index + 1 < len(caption_breaks) else DURATION
        assert end > start
        cues.append(f'{index + 1}\n{stamp(start)} --> {stamp(end)}\n{text}\n')
    SUBTITLE.write_text('\n'.join(cues), encoding='utf-8-sig')


def encode(reuse_render=False):
    pending = EVIDENCE / 'highlights-video-only.mp4'
    command = [ffmpeg, '-y', '-hide_banner', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24',
               '-s', f'{W}x{H}', '-r', str(FPS), '-i', 'pipe:0', '-an', '-c:v', 'libx264',
               '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', str(pending)]
    if reuse_render:
        assert pending.exists() and pending.stat().st_size > 1_000_000
    else:
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
        cache = {}
        try:
            for index in range(TOTAL_FRAMES):
                process.stdin.write(compose(index, cache).tobytes())
                if index % (FPS * 15) == 0:
                    print(json.dumps({'renderedSeconds':index / FPS, 'totalSeconds':DURATION}), flush=True)
            process.stdin.close()
            error = process.stderr.read().decode('utf-8', errors='replace')
            assert process.wait() == 0, error
        except BaseException:
            process.kill()
            raise
    # A continuous original score avoids musical phase jumps between the edits.
    # It fades before the real element tap, giving the captured product BGM the
    # same start as the actual interaction rather than replacing it with music.
    scene = next(item for item in segments if item['key'] == 'scene')
    actual_audio = record['audio'][0]
    tap = scene['outputStart'] + actual_audio['start'] - scene['sourceStart']
    scene_end = scene['outputEnd']
    fade = tap - 3
    envelope = f'if(lt(t,{fade}),1,if(lt(t,{tap}),({tap}-t)/3,if(lt(t,{scene_end}),0,if(lt(t,{scene_end + 2.5}),(t-{scene_end})/2.5,1))))'
    filters = [
        f"[1:a]atrim=duration={DURATION},asetpts=PTS-STARTPTS,volume='{envelope}':eval=frame,afade=t=in:d=0.6,afade=t=out:st={DURATION - 2}:d=2[score]",
        f"[2:a]atrim=duration={scene_end - tap},asetpts=PTS-STARTPTS,loudnorm=I=-23:TP=-3:LRA=6,afade=t=out:st={max(0, scene_end - tap - .4)}:d=0.4,adelay={round(tap * 1000)}:all=1[scene]",
        f'[score][scene]amix=inputs=2:duration=longest:normalize=0,apad,atrim=duration={DURATION},alimiter=limit=0.891:level=false[audio]',
    ]
    pending_final = EVIDENCE / 'highlights-final.mp4'
    subprocess.run([ffmpeg, '-y', '-hide_banner', '-v', 'error', '-i', str(pending), '-stream_loop', '-1', '-i',
                    str(ROOT / 'submission/伴途演示配乐.mp3'), '-i', str(directory / actual_audio['file']),
                    '-filter_complex', ';'.join(filters), '-map', '0:v:0', '-map', '[audio]', '-c:v', 'copy',
                    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-t', str(DURATION), '-movflags', '+faststart', str(pending_final)], check=True)
    assert pending_final.stat().st_size > 1_000_000
    pending_final.replace(VIDEO)
    write_srt()
    return {'sceneAudioTap':tap, 'sceneAudioEnd':scene_end, 'recordedSceneAudio':actual_audio,
            'editorialMusic':str(ROOT / 'submission/伴途演示配乐.mp3')}


SAMPLES = [1, 9, 21, 31, 43, 54, 72, 87, 104, 118, 127]


def verify(audio_proof=None):
    # ffprobe is not installed here: these facts are obtained by the actual
    # FFmpeg stream inspector, full decoder and audio volume filter instead.
    inspect = subprocess.run([ffmpeg, '-hide_banner', '-i', str(VIDEO), '-t', '0', '-f', 'null', '-'], capture_output=True, text=True, encoding='utf-8', errors='replace')
    (EVIDENCE / 'stream-inspection.txt').write_text(inspect.stderr, encoding='utf-8')
    assert inspect.returncode == 0
    decode = subprocess.run([ffmpeg, '-hide_banner', '-v', 'info', '-i', str(VIDEO), '-map', '0:v:0', '-map', '0:a:0',
                             '-vf', 'showinfo', '-af', 'volumedetect', '-f', 'null', '-'], capture_output=True, text=True, encoding='utf-8', errors='replace')
    (EVIDENCE / 'full-decode.txt').write_text(decode.stderr, encoding='utf-8')
    assert decode.returncode == 0
    decoded = re.findall(r'\bn:\s*(\d+)\s+pts:', decode.stderr)
    assert len(decoded) == TOTAL_FRAMES and int(decoded[-1]) + 1 == TOTAL_FRAMES
    assert re.search(r'Video: h264.*1920x1080.*30 fps', inspect.stderr)
    assert re.search(r'Audio: aac.*48000 Hz', inspect.stderr)
    volume = re.search(r'mean_volume:\s*(-?[\d.]+) dB', decode.stderr)
    peak = re.search(r'max_volume:\s*(-?[\d.]+) dB', decode.stderr)
    assert volume and peak and -50 < float(volume.group(1)) < -10 and float(peak.group(1)) <= 0
    screenshots = []
    for number, t in enumerate(SAMPLES):
        screenshot = EVIDENCE / f'encoded-{number:02}-{t:03}s.png'
        subprocess.run([ffmpeg, '-y', '-hide_banner', '-v', 'error', '-ss', str(t), '-i', str(VIDEO), '-frames:v', '1', str(screenshot)], check=True)
        screenshots.append(screenshot)
    # Contact sheet uses encoded output, not the pre-encoding preview plates.
    sheet = Image.new('RGB', (1920, math.ceil(len(screenshots) / 3) * 388), '#dfe7f3')
    draw = ImageDraw.Draw(sheet)
    for number, screenshot in enumerate(screenshots):
        image = Image.open(screenshot).convert('RGB').resize((640, 360), Image.Resampling.LANCZOS)
        x, y = number % 3 * 640, number // 3 * 388
        sheet.paste(image, (x, y + 28))
        draw.text((x + 8, y + 2), f'{SAMPLES[number]}s', font=font(19), fill=INK)
    sheet.save(EVIDENCE / 'encoded-contactsheet.jpg', quality=95)
    srt = SUBTITLE.read_text(encoding='utf-8-sig')
    intervals = re.findall(r'(\d\d:\d\d:\d\d,\d\d\d) --> (\d\d:\d\d:\d\d,\d\d\d)', srt)
    assert len(intervals) == len(caption_breaks)
    assert intervals[0][0] == stamp(0) and intervals[-1][1] == stamp(DURATION)
    assert all(previous[1] == current[0] for previous, current in zip(intervals, intervals[1:]))
    video_hash = hashlib.sha256(VIDEO.read_bytes()).hexdigest()
    original_after = hashlib.sha256(ORIGINAL_VIDEO.read_bytes()).hexdigest()
    assert original_after == ORIGINAL_SHA256, 'The long film is an immutable input.'
    previous_proof_path = EVIDENCE / 'proof.json'
    if audio_proof is None and previous_proof_path.exists():
        previous_proof = json.loads(previous_proof_path.read_text(encoding='utf-8'))
        if previous_proof.get('sha256') == video_hash:
            audio_proof = {key:previous_proof[key] for key in ['sceneAudioTap', 'sceneAudioEnd', 'recordedSceneAudio', 'editorialMusic'] if key in previous_proof}
    section_audio = {}
    audio_windows = {'modelWait':(start_for['adjust'] + 13.7, 20),
                     'sceneElementMusic':((audio_proof or {}).get('sceneAudioTap', 98.93315793333332), 10),
                     'privateReview':(start_for['memory'] + 3, 8)}
    for name, (start, seconds) in audio_windows.items():
        result = subprocess.run([ffmpeg, '-hide_banner', '-ss', str(start), '-t', str(seconds), '-i', str(VIDEO),
                                 '-vn', '-af', 'volumedetect', '-f', 'null', '-'], capture_output=True, text=True, encoding='utf-8', errors='replace')
        (EVIDENCE / f'audio-{name}.txt').write_text(result.stderr, encoding='utf-8')
        value = re.search(r'mean_volume:\s*(-?[\d.]+) dB', result.stderr)
        assert result.returncode == 0 and value and float(value.group(1)) > -45
        section_audio[name] = {'start':start, 'seconds':seconds, 'meanVolumeDb':float(value.group(1))}
    proof = {'video':str(VIDEO), 'subtitle':str(SUBTITLE), 'bytes':VIDEO.stat().st_size,
             'sha256':video_hash, 'width':W, 'height':H, 'fps':FPS,
             'seconds':DURATION, 'encodedFrames':TOTAL_FRAMES, 'fullyDecodedFrames':len(decoded),
             'audioCodec':'AAC', 'sampleRate':48000, 'meanVolumeDb':float(volume.group(1)), 'peakVolumeDb':float(peak.group(1)),
             'audioSectionsNonSilent':section_audio,
             'subtitleCues':len(intervals), 'subtitlesContinuous':True, 'sourceFrames':len(frames),
             'sourceRecordingDirectory':str(directory), 'sourceRecordingKind':record['source'], 'realModelSource':True,
             'sourceModelErrors':record.get('modelErrors', []), 'isolatedAccounts':True,
             'simulatedGpsRoadsClockDisclosedInEveryFrame':True, 'artSceneNotRealFootageDisclosed':True,
             'androidNativeFootageClaimed':False, 'segments':segments, 'modelWaitSource':[174.7506534, 196.4021227],
             'modelWaitPreservedAtNaturalSpeed':True, 'inspectionTool':'FFmpeg stream inspection and full showinfo/volumedetect decode; ffprobe unavailable',
             'encodedScreenshots':[str(path) for path in screenshots], 'contactSheet':str(EVIDENCE / 'encoded-contactsheet.jpg'),
             'originalLongVideoModified':False, 'originalLongVideoSha256Before':ORIGINAL_SHA256,
             'originalLongVideoSha256After':original_after, **(audio_proof or {})}
    (EVIDENCE / 'proof.json').write_text(json.dumps(proof, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(proof, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--preview', action='store_true')
    parser.add_argument('--verify-only', action='store_true')
    parser.add_argument('--reuse-render', action='store_true')
    args = parser.parse_args()
    if args.preview:
        cache = {}
        for number, t in enumerate(SAMPLES):
            compose(round(t * FPS), cache).save(EVIDENCE / f'preview-{number:02}-{t:03}s.png')
        print(json.dumps({'seconds':DURATION, 'frames':TOTAL_FRAMES, 'previewDirectory':str(EVIDENCE)}))
    elif args.verify_only:
        verify()
    else:
        audio = encode(args.reuse_render)
        verify(audio)
