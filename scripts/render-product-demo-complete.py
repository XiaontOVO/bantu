"""A faithful current-product film, with explicit independent supplements.

Operations are never accelerated. Documented cuts omit only static timeout
waiting; the true error and 60-second latency remain disclosed. Detail panels
are crops of the same source frame, never recreated UI.
"""
import argparse, bisect, hashlib, json, math, re, subprocess, sys
from functools import lru_cache
from collections import OrderedDict
from io import BytesIO
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
EVIDENCE = ROOT / 'tmp/complete-demo-video'
EVIDENCE.mkdir(parents=True, exist_ok=True)
VIDEO = ROOT / 'submission/伴途完整产品演示.mp4'
SUBTITLE = ROOT / 'submission/伴途完整产品演示.srt'
directory = ROOT / 'tmp/complete-demo-recording-2026-10-05T03-23-34-679Z'
main = json.loads((directory / 'timeline.json').read_text(encoding='utf-8'))
main['directory'] = str(directory)
assert main['realModel'] and main['isolatedData'] and main['protectedConfigurationUnchanged']
assert main['failed'] and main['phase']=='memory'
assert main['modelErrors']==[{'call':9,'phase':'memory','code':'MODEL_TIMEOUT'}]
assert not main['simulatedRoads'] and main['realRoadProvider']
tail_directory=ROOT/'tmp/complete-demo-tail-2026-10-05T03-50-44-135Z'
tail=json.loads((tail_directory/'timeline.json').read_text(encoding='utf-8'));tail['directory']=str(tail_directory)
end_record=json.loads((ROOT/'tmp/complete-demo-end.json').read_text(encoding='utf-8'))
tail_lead_directory=ROOT/'tmp/complete-demo-tail-2026-10-05T03-42-05-440Z'
tail_lead=json.loads((tail_lead_directory/'timeline.json').read_text(encoding='utf-8'))
tail_lead['directory']=str(tail_lead_directory)
assert tail_lead['failed'] and tail_lead['phase']=='private-publication'
assert any(turn['tools']==['memories.edit'] for turn in tail_lead['modelTurns'])
assert tail['planId']=='plan_d2b5abcc-bb6d-4c98-a0a4-9b6d001b8ab4'
assert any(check['label']=='resume restores exact actually saved independent tail state' for check in tail['checks'])
tail_lead_end=next(cue['t'] for cue in tail_lead['cues'] if cue['chapter'].startswith('10'))
tail_pub_directory=ROOT/'tmp/complete-demo-tail-2026-10-05T03-46-58-371Z'
tail_pub=json.loads((tail_pub_directory/'timeline.json').read_text(encoding='utf-8'));tail_pub['directory']=str(tail_pub_directory)
assert tail_pub['failed'] and any(check['label']=='actual private publication saved exact title' for check in tail_pub['checks'])
tail_start=next(cue['t'] for cue in tail['cues'] if cue['title']=='已发布的私密帖子，核对真实结果')
tail_end=next(i['t'] for i in tail['interactions'] if i.get('selector')=='[data-action=open-agent-conversations]')+5.8
scene = json.loads((ROOT / 'tmp/complete-demo-scene-question.json').read_text(encoding='utf-8'))
for supplement in (tail,scene,end_record):
    assert supplement['realModel'] and supplement['isolatedData']
    assert supplement['protectedConfigurationUnchanged']
assert not scene['failed'] and not end_record['failed']
assert tail['failed'] and tail['phase']=='preferences'

memory_request=next(i for i in main['interactions'] if i.get('kind')=='natural-language' and i['phase']=='memory')
submit=next(i for i in main['interactions'] if i['phase']=='memory' and i.get('selector')=='[data-chat-form] button[type=submit]')
cut_start=submit['t']+4
edit_cuts=[{'source':str(directory),'start':cut_start,'end':cut_start+50,'reason':'50 seconds of static waiting inside the actual 60.003-second MODEL_TIMEOUT; no operation removed'},
           {'source':str(directory),'start':memory_request['finished']+8,'end':main['duration']-3,'reason':'Static script deadline polling after the visible failure; no user or model action removed'}]
main['cues'].append({'t':submit['t']+60.003+.3,'chapter':'09 / 12','title':'真实服务超时，补写未完成','subtitle':'这次模型请求60秒超时，未写入感受。中间静态等待省略50秒，操作保持原速。','points':[]})
main['cues'].sort(key=lambda item:item['t'])
insert_at=next(cue['t'] for cue in main['cues'] if cue['chapter'].startswith('06'))

def trim_time(t):
    return t-sum(max(0,min(t,cut['end'])-cut['start']) for cut in edit_cuts)

def kept(t):
    return not any(cut['start']<=t<cut['end'] for cut in edit_cuts)

frames,cues,touches,audio=[],[],[],[]
def append_source(source,mapping,label,trim=False,end=None,begin=None):
    srcdir=Path(source['directory'])
    raw=[json.loads(line) for line in (srcdir/'frames.jsonl').read_text().splitlines()]
    assert len(raw)==source['sourceFrames']
    for frame in raw:
        if begin is not None and frame['t']<begin:continue
        if end is not None and frame['t']>=end:continue
        if trim and not kept(frame['t']):continue
        frames.append({**frame,'t':mapping(frame['t']),'path':str(srcdir/'frames'/frame['file']),'sourceLabel':label})
    for cue in source['cues']:
        if begin is not None and cue['t']<begin:continue
        if end is not None and cue['t']>=end:continue
        # Cues in omitted waiting never describe actions, but their final state
        # would be carried forward at the edit boundary if present.
        cues.append({**cue,'t':mapping(cue['t']),'sourceLabel':label})
    for touch in source['touches']:
        if begin is not None and touch['t']<begin:continue
        if end is not None and touch['t']>=end:continue
        assert not trim or kept(touch['t']),'Cannot remove an actual touch'
        touches.append({**touch,'t':mapping(touch['t'])})
    for item in source.get('audio',[]):
        audio.append({**item,'start':mapping(item['start']),'file':str(srcdir/item['file']),'sourceLabel':label})

append_source(main,lambda t:trim_time(t)+(scene['duration'] if t>=insert_at else 0),'主线原录 · 原服务',True)
scene_begin=trim_time(insert_at)
append_source(scene,lambda t:scene_begin+t,'场景提问补录 · 独立服务')
tail_begin=trim_time(main['duration'])+scene['duration']
append_source(tail_lead,lambda t:tail_begin+t,'回顾与发布补录 · 独立样例',end=tail_lead_end)
append_source(tail_pub,lambda t:tail_begin+tail_lead_end+t,'私密发布实录 · 独立样例原快照')
append_source(tail,lambda t:tail_begin+tail_lead_end+tail_pub['duration']+t-tail_start,'结果与设置续录 · 独立样例原快照',begin=tail_start,end=tail_end)
end_begin=tail_begin+tail_lead_end+tail_pub['duration']+tail_end-tail_start
append_source(end_record,lambda t:end_begin+t,'新会话与收尾 · 独立样例原快照')

# The original failed recording had not exported its in-memory WebAudio.
# A genuine recording of the same current-product brick element is used,
# with persistent disclosure. It is not claimed to be synchronous source audio.
brick=next(i['t'] for i in main['interactions'] if i.get('selector')=='[data-action=select-scene-hotspot][data-hotspot=brick-facade]')
assert scene['audio'],'The actual supplemental scene audio must exist'
audio.append({**scene['audio'][0],'start':trim_time(brick),'file':str(Path(scene['directory'])/scene['audio'][0]['file']),'maxDuration':13.5,'sourceLabel':'原主线红砖：同元素独立实录采样'})

frames.sort(key=lambda item:item['t']);cues.sort(key=lambda item:item['t']);touches.sort(key=lambda item:item['t'])
record={**main,'duration':end_begin+end_record['duration'],'cues':cues,'touches':touches,'audio':audio,
        'modelCalls':main['modelCalls']+scene['modelCalls']+tail_lead['modelCalls']+tail['modelCalls'],
        'modelErrors':[{'recording':label,**error} for label,source in [('main',main),('scene-supplement',scene),('tail-supplement',tail_lead),('tail-resume',tail)] for error in source['modelErrors']],
        'checks':main['checks']+scene['checks']+tail_lead['checks']+tail_pub['checks']+tail['checks']+end_record['checks'],'restBefore':None,'restAfter':None}
for cue in cues:
    if cue['sourceLabel']=='主线原录 · 原服务' and cue['title']=='到达以后，让地点活起来':
        cue['subtitle']='横屏点红砖，触发文字讲解。此段音乐取自同一元素的独立实录。'
    if cue['sourceLabel'].startswith('场景提问补录') and cue['title']=='刚点的元素，一句就能问':
        cue['subtitle']='真实模型正结合当前地点和红砖元素回答；这次没有修改计划。'
    if cue['sourceLabel']=='主线原录 · 原服务' and cue['chapter'].startswith('09') and cue['title']=='把自己的原话，补进同一条回顾':
        cue['subtitle']='真实模型正在处理；本次超时反馈与实际等待耗时随后说明。'
    if cue['chapter'].startswith('11'):
        cue['subtitle']='独立样例的三站记录与来源：到访次数来自进度事件，不把预置数据当成现场游览验收。'
times = [frame['t'] for frame in frames]
assert all(b >= a for a, b in zip(times, times[1:]))
cues = record['cues']
cue_times = [cue['t'] for cue in cues]
TOTAL_FRAMES = math.ceil(record['duration'] * FPS)
DURATION = TOTAL_FRAMES / FPS
ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
INK, MUTED, BLUE = '#26334c', '#6c7e95', '#426aee'

def font(size, bold=False):
    return ImageFont.truetype('C:/Windows/Fonts/' + ('msyhbd.ttc' if bold else 'msyh.ttc'), size)

F = {name:font(size,bold) for name,size,bold in
     [('brand',32,True),('title',46,True),('body',25,False),('caption',31,False),
      ('chapter',24,True),('small',21,False),('foot',15,False)]}
CHAPTER_NAMES = ['发现地点','精细安排','Agent规划','出发与路线','触摸风景','临时休息',
                 '场馆资料','接着旅程','私人回顾','私密发布','旅行成就','个人偏好']

@lru_cache(maxsize=256)
def wrap(text,face,width):
    lines, line = [], ''
    for char in text:
        if char=='\n' or face.getlength(line+char)>width:
            lines.append(line);line='' if char=='\n' else char
        else:line += char
    if line:lines.append(line)
    return lines

yy,xx=np.mgrid[0:H,0:W]
cool=np.exp(-((xx-600)**2/1000**2+(yy-300)**2/900**2))
warm=np.exp(-((xx-1800)**2/1100**2+(yy-950)**2/1100**2))
pixels=np.zeros((H,W,3))+np.array([247,249,252])
pixels+=cool[:,:,None]*np.array([-13,-8,1])+warm[:,:,None]*np.array([5,1,-9])
BACKGROUND=Image.fromarray(np.clip(pixels,0,255).astype('uint8'))
brand=Image.open(ROOT/'tmp/bantu-demo-brand.png').convert('RGBA').resize((39,39),Image.Resampling.LANCZOS)

def section(cue):
    return int(cue['chapter'].split('/')[0])-1

def focus_fraction(cue,t=None):
    # A labelled full-width crop: no substituted, reconstructed, or hidden UI.
    chapter=section(cue)
    private_offset=tail_begin+tail_lead_end
    if t is not None and private_offset+31.75<=t<=private_offset+33.3:return (.025,.14,.975,.47)
    if cue['sourceLabel'].startswith('场景提问补录') and cue['title']!='补充：参观时，随时问伴途':
        return (.025,.60,.975,.93)
    if cue['title']=='真实服务超时，补写未完成':return (.025,.45,.975,.78)
    if chapter in (0,3,6,10):return (.025,.20,.975,.53)
    if chapter in (2,5,8):return (.025,.39,.975,.72)
    if chapter==9:return (.025,.22,.975,.55)
    return (.025,.30,.975,.63)

def plate(cue,landscape):
    canvas=BACKGROUND.copy();canvas.paste(brand,(58,20),brand)
    d=ImageDraw.Draw(canvas)
    d.text((111,18),'伴途',font=F['brand'],fill=INK)
    d.text((216,29),'完整产品演示',font=F['small'],fill=MUTED)
    source_label=cue['sourceLabel']
    d.text((1155,29),source_label+' · 真实模型 / 移动网页',font=F['small'],fill=MUTED)
    d.line((58,78,1862,78),fill='#dce5f0',width=1)
    chapter=section(cue)
    if not landscape:
        d.rounded_rectangle((774,99,1004,143),radius=22,fill='#e8efff')
        d.text((795,105),f'{chapter+1:02d} / 12  {CHAPTER_NAMES[chapter]}',font=F['chapter'],fill=BLUE)
        lines=wrap(cue['title'],F['title'],1050)
        for number,line in enumerate(lines):d.text((773,162+number*56),line,font=F['title'],fill=INK)
        if len(lines)>1:
            note_y=282
        else:note_y=243
        d.text((777,note_y),'同一原画局部放大 · 界面内容未改写',font=F['small'],fill=MUTED)
        d.rounded_rectangle((766,note_y+42,1855,916),radius=22,fill='white',outline='#dbe4ef',width=1)
    else:
        d.text((66,91),f'{chapter+1:02d} / 12  {cue["title"]}',font=F['small'],fill=MUTED)
        d.text((1460,91),'AI艺术场景 · 非实景影像',font=F['small'],fill=MUTED)
    return canvas

def paste_shadow(canvas,image,x,y,radius=18):
    shadow=Image.new('RGBA',canvas.size);sd=ImageDraw.Draw(shadow)
    sd.rounded_rectangle((x-3,y+9,x+image.width+3,y+image.height+14),radius=radius,fill=(28,50,84,30))
    shadow=shadow.filter(ImageFilter.GaussianBlur(12));canvas.paste(shadow,(0,0),shadow)
    mask=Image.new('L',image.size);ImageDraw.Draw(mask).rounded_rectangle((0,0,image.width,image.height),radius=radius,fill=255)
    canvas.paste(image,(x,y),mask)

def compose(index,cache):
    t=index/FPS
    fi=max(0,bisect.bisect_right(times,t)-1)
    if fi!=cache.get('fi'):
        payload=Path(frames[fi]['path']).read_bytes();source_key=hashlib.sha256(payload).digest()
        sources=cache.setdefault('source_variants',OrderedDict())
        if source_key not in sources:
            sources[source_key]=Image.open(BytesIO(payload)).convert('RGB')
            if len(sources)>40:sources.popitem(last=False)
        cache['source']=sources[source_key];cache['source_key']=source_key;cache['fi']=fi
    source=cache['source'];ci=max(0,bisect.bisect_right(cue_times,t)-1);cue=cues[ci]
    landscape=source.width>source.height
    if (ci,landscape)!=cache.get('plate_key'):
        cache['plate']=plate(cue,landscape);cache['plate_key']=(ci,landscape)
    layout_key=(ci,cache['source_key'],focus_fraction(cue,t))
    layouts=cache.setdefault('layouts',OrderedDict())
    if layout_key in layouts:
        base,x,y,scale,roi,zx,zy,zscale=layouts[layout_key];canvas=base.copy()
    else:
        canvas=cache['plate'].copy()
        box=(65,124,1855,968) if landscape else (80,93,697,982)
        scale=min((box[2]-box[0])/source.width,(box[3]-box[1])/source.height)
        size=(round(source.width*scale),round(source.height*scale))
        x,y=round((box[0]+box[2]-size[0])/2),round((box[1]+box[3]-size[1])/2)
        photo=source.resize(size,Image.Resampling.LANCZOS)
        # Cache expensive shadow/mask geometry. The image itself remains live.
        key=x,y,size,landscape
        if key!=cache.get('main_key'):
            layer=Image.new('RGBA',(W,H));sd=ImageDraw.Draw(layer)
            sd.rounded_rectangle((x-3,y+9,x+size[0]+3,y+size[1]+14),radius=20,fill=(28,50,84,32))
            cache['main_shadow']=layer.filter(ImageFilter.GaussianBlur(13))
            mask=Image.new('L',size);ImageDraw.Draw(mask).rounded_rectangle((0,0,*size),radius=18,fill=255)
            cache['main_mask']=mask;cache['main_key']=key
        canvas.paste(cache['main_shadow'],(0,0),cache['main_shadow']);canvas.paste(photo,(x,y),cache['main_mask'])
        d=ImageDraw.Draw(canvas)
        roi=None;zx=zy=zscale=0
        if not landscape:
            frac=focus_fraction(cue,t);roi=tuple(round(a*b) for a,b in zip(frac,(source.width,source.height,source.width,source.height)))
            detail=source.crop(roi)
            title_lines=wrap(cue['title'],F['title'],1050);note_y=282 if len(title_lines)>1 else 243
            zbox=(777,note_y+53,1844,905)
            zscale=min((zbox[2]-zbox[0])/detail.width,(zbox[3]-zbox[1])/detail.height)
            zsize=(round(detail.width*zscale),round(detail.height*zscale))
            zx,zy=round((zbox[0]+zbox[2]-zsize[0])/2),round((zbox[1]+zbox[3]-zsize[1])/2)
            canvas.paste(detail.resize(zsize,Image.Resampling.LANCZOS),(zx,zy))
            d=ImageDraw.Draw(canvas)
            # The rectangle locates the exact crop in the complete phone image.
            d.rounded_rectangle((x+roi[0]*scale,y+roi[1]*scale,x+roi[2]*scale,y+roi[3]*scale),radius=4,outline=BLUE,width=2)
        layouts[layout_key]=(canvas.copy(),x,y,scale,roi,zx,zy,zscale)
        if len(layouts)>40:layouts.popitem(last=False)
    d=ImageDraw.Draw(canvas)
    for touch in record['touches']:
        age=t-touch['t']
        if 0<=age<.65:
            tx,ty=touch['x']*source.width,touch['y']*source.height
            radius=11+age*13
            d.ellipse((x+tx*scale-radius,y+ty*scale-radius,x+tx*scale+radius,y+ty*scale+radius),outline=BLUE,width=3)
            if roi and roi[0]<=tx<=roi[2] and roi[1]<=ty<=roi[3]:
                a,b=zx+(tx-roi[0])*zscale,zy+(ty-roi[1])*zscale
                d.ellipse((a-radius,b-radius,a+radius,b+radius),outline=BLUE,width=3)
    if ci!=cache.get('footer_key'):
        footer=Image.new('RGBA',(W,H));d=ImageDraw.Draw(footer)
        lines=wrap(cue['subtitle'],F['caption'],1780)
        assert len(lines)<=2,cue['subtitle']
        cy=976 if len(lines)==2 else 993
        for n,line in enumerate(lines):d.text(((W-F['caption'].getlength(line))/2,cy+n*35),line,font=F['caption'],fill=INK)
        # Editorial chapters and progress are separate from the application's facts.
        for chapter in range(12):
            bx=58+chapter*150;active=chapter==section(cue)
            d.line((bx,1053,bx+134,1053),fill=BLUE if active else '#d5dfed',width=3)
        d.text((58,1060),'移动网页实录 · 演示GPS/时钟 · 实际道路（非现场导航） · 主线场景BGM取自同元素补录；未录入设备语音',font=F['foot'],fill=MUTED)
        cache['footer']=footer.crop((0,976,W,H));cache['footer_key']=ci
    canvas.paste(cache['footer'],(0,976),cache['footer'])
    d=ImageDraw.Draw(canvas)
    d.text((1645,1060),f'{int(t)//60:02d}:{int(t)%60:02d}  /  {int(DURATION)//60:02d}:{int(DURATION)%60:02d}',font=F['foot'],fill=MUTED)
    return canvas

def stamp(value):
    ms=round(value*1000);h,ms=divmod(ms,3600000);m,ms=divmod(ms,60000);s,ms=divmod(ms,1000)
    return f'{h:02d}:{m:02d}:{s:02d},{ms:03d}'

def write_srt():
    result=[]
    for i,cue in enumerate(cues):
        start=0 if i==0 else cue['t'];end=cues[i+1]['t'] if i+1<len(cues) else DURATION
        result.append(f'{i+1}\n{stamp(start)} --> {stamp(end)}\n{cue["subtitle"]}\n')
    SUBTITLE.write_text('\n'.join(result),encoding='utf-8-sig')

def encode(reuse=False,repair_burn_in=False):
    pending=EVIDENCE/'complete-video-only.mp4'
    if not reuse:
        process=subprocess.Popen([ffmpeg,'-y','-hide_banner','-v','error','-f','rawvideo','-pix_fmt','rgb24','-s',f'{W}x{H}','-r',str(FPS),'-i','pipe:0','-an','-c:v','libx264','-preset','fast','-crf','18','-pix_fmt','yuv420p','-movflags','+faststart',str(pending)],stdin=subprocess.PIPE,stderr=subprocess.PIPE)
        cache={}
        try:
            for index in range(TOTAL_FRAMES):
                process.stdin.write(compose(index,cache).tobytes())
                if index%(FPS*30)==0:print(json.dumps({'renderedSeconds':index/FPS,'totalSeconds':DURATION}),flush=True)
            process.stdin.close();error=process.stderr.read().decode('utf-8',errors='replace');assert process.wait()==0,error
        except BaseException:
            process.kill();raise
    assert pending.exists() and pending.stat().st_size>1_000_000
    music=ROOT/'submission/伴途演示配乐.mp3';audio=record['audio'];assert audio
    windows=[]
    for item in audio:
        info=subprocess.run([ffmpeg,'-hide_banner','-i',str(directory/item['file'])],capture_output=True,text=True,encoding='utf-8',errors='replace').stderr
        duration=re.search(r'Duration:\s*(\d+):(\d+):([\d.]+)',info)
        if duration:
            length=int(duration[1])*3600+int(duration[2])*60+float(duration[3])
        else:
            # MediaRecorder's live WebM has no seekable Duration metadata.
            # Decode the actual stream and measure its last output timestamp.
            measure=subprocess.run([ffmpeg,'-hide_banner','-i',str(directory/item['file']),'-vn','-f','null','-'],capture_output=True,text=True,encoding='utf-8',errors='replace')
            stamps=re.findall(r'time=(\d+):(\d+):([\d.]+)',measure.stderr)
            assert measure.returncode==0 and stamps,measure.stderr
            length=max(int(h)*3600+int(m)*60+float(s) for h,m,s in stamps)
        length=min(length,item.get('maxDuration',length));windows.append((max(0,item['start']),min(DURATION,item['start']+length),item))
    envelope='1'
    for start,end,_ in reversed(windows):
        fade=max(0,start-3)
        envelope=f'if(lt(t,{fade}),{envelope},if(lt(t,{start}),({start}-t)/3,if(lt(t,{end}),0,if(lt(t,{end+2.5}),(t-{end})/2.5,{envelope}))))'
    command=[ffmpeg,'-y','-hide_banner','-v','error','-i',str(pending),'-stream_loop','-1','-i',str(music)]
    filters=[f"[1:a]atrim=duration={DURATION},asetpts=PTS-STARTPTS,volume='{envelope}':eval=frame,afade=t=in:d=0.6,afade=t=out:st={DURATION-2}:d=2[score]"]
    for i,(start,end,item) in enumerate(windows):
        command+=['-i',str(directory/item['file'])]
        filters.append(f'[{i+2}:a]atrim=duration={end-start},loudnorm=I=-23:TP=-3:LRA=6,afade=t=out:st={max(0,end-start-.4)}:d=0.4,adelay={round(start*1000)}:all=1[scene{i}]')
    streams='[score]'+''.join(f'[scene{i}]' for i in range(len(windows)))
    filters.append(f'{streams}amix=inputs={len(windows)+1}:duration=longest:normalize=0,apad,atrim=duration={DURATION},alimiter=limit=.891:level=false[audio]')
    video_map='0:v:0'
    if repair_burn_in:
        previous='0:v'
        corrections=[(i,cue) for i,cue in enumerate(cues) if cue['title'] in ['到达以后，让地点活起来','刚点的元素，一句就能问']]
        for n,(i,cue) in enumerate(corrections):
            band=BACKGROUND.crop((0,982,W,1051));d=ImageDraw.Draw(band)
            lines=wrap(cue['subtitle'],F['caption'],1780);cy=978 if len(lines)==2 else 993
            for j,line in enumerate(lines):d.text(((W-F['caption'].getlength(line))/2,cy+j*35-982),line,font=F['caption'],fill=INK)
            png=EVIDENCE/f'caption-correction-{i:02d}.png';band.save(png)
            command+=['-loop','1','-framerate',str(FPS),'-i',str(png)]
            end_time=cues[i+1]['t'] if i+1<len(cues) else DURATION
            filters.append(f"[{previous}][{2+len(windows)+n}:v]overlay=0:982:enable='gte(t,{cue['t']})*lt(t,{end_time})'[fixed{n}]")
            previous=f'fixed{n}'
        video_map=f'[{previous}]'
    command+=['-filter_complex',';'.join(filters),'-map',video_map,'-map','[audio]']
    command+=['-c:v','libx264','-preset','fast','-crf','18','-pix_fmt','yuv420p','-r',str(FPS)] if repair_burn_in else ['-c:v','copy']
    command+=['-c:a','aac','-b:a','192k','-ar','48000','-t',str(DURATION),'-movflags','+faststart',str(VIDEO)]
    subprocess.run(command,check=True);write_srt()
    return [{'start':a,'end':b,'file':item['file'],'sourceLabel':item['sourceLabel']} for a,b,item in windows]

def proof(windows=None):
    gaps=np.diff(times)
    chapters=[]
    for number in range(12):
        first=next(cue for cue in cues if section(cue)==number)
        end=next((cue['t'] for cue in cues if section(cue)>number),DURATION)
        chapters.append({'number':number+1,'name':CHAPTER_NAMES[number],'start':0 if number==0 else first['t'],'end':end,'actions':[cue['title'] for cue in cues if section(cue)==number]})
    report={'video':str(VIDEO),'subtitle':str(SUBTITLE),'recordingDirectory':str(directory),'sourceRecording':str(ROOT/'tmp/complete-demo-recording.json'),'width':W,'height':H,'fps':FPS,'seconds':DURATION,'frames':TOTAL_FRAMES,'sourceFrames':len(frames),'sourceAverageFps':round(len(frames)/record['duration'],2),'sourceFrameGapMedian':float(np.median(gaps)),'sourceFrameGapP95':float(np.quantile(gaps,.95)),'sourceFrameGapMax':float(np.max(gaps)),'sourceLongGapsOver200ms':int(np.sum(gaps>.2)),'chapters':chapters,'subtitleCues':len(cues),'sourceKind':record['source'],'operationsAndModelWaitsNaturalSpeed':True,'detailPanelIsSameFrameCrop':True,'capturedWebSpeech':False,'originalScore':str(ROOT/'submission/伴途演示配乐.mp3'),'actualSceneAudio':windows or [],'realRoadProvider':record['realRoadProvider'],'realModelCalls':record['modelCalls'],'modelErrors':record['modelErrors'],'isolatedData':True,'simulatedGpsAndClock':True,'simulatedRoads':False,'protectedConfigurationUnchanged':True,'checks':record['checks'],'restBefore':record['restBefore'],'restAfter':record['restAfter'],'sha256':hashlib.sha256(VIDEO.read_bytes()).hexdigest() if VIDEO.exists() else None,'bytes':VIDEO.stat().st_size if VIDEO.exists() else None}
    attempts=[]
    for timeline in sorted((ROOT/'tmp').glob('complete-demo-*/timeline.json')):
        trial=json.loads(timeline.read_text(encoding='utf-8'))
        attempts.append({'directory':str(timeline.parent),'featuredInFilm':str(timeline.parent) in [str(directory),scene['directory'],tail_lead['directory'],tail_pub['directory'],tail['directory'],end_record['directory']],
                         'failed':trial.get('failed',False),'phase':trial.get('phase'),'error':trial.get('error'),'modelCalls':trial.get('modelCalls',0),
                         'modelTurns':trial.get('modelTurns',[]),'modelErrors':trial.get('modelErrors',[])})
    report.update({'sourceRecording':str(directory/'timeline.json'),
        'sourceRecordings':[{'directory':source['directory'],'role':label,'planId':source.get('planId'),'failed':source.get('failed',False)} for label,source in [('continuous-main-1-to-8-with-visible-9-timeout',main),('independent-scene-question',scene),('independent-memory-9',tail_lead),('same-independent-snapshot-real-private-publication',tail_pub),('same-independent-snapshot-privacy-verification-achievements-settings',tail),('same-independent-snapshot-new-conversation-and-end',end_record)]],
        'editCuts':edit_cuts+[{'source':tail_lead['directory'],'start':tail_lead_end,'end':tail_lead['duration'],'reason':'Omit duplicate publication setup and script-only wrong-selector wait; actual publication retained from restored exact snapshot'},
                             {'source':tail['directory'],'start':0,'end':tail_start,'reason':'Omit duplicate recap reopening after exact snapshot restore; result and privacy verification retained'},
                             {'source':tail['directory'],'start':tail_end,'end':tail['duration'],'reason':'Script selected an obscured duplicate new-conversation button; keep actual list entry, replace only this unsuccessful control attempt with scoped actual new-conversation recording'}],
        'operationsAndModelWaitsNaturalSpeed':False,'shownOperationsNaturalSpeed':True,'modelWaitsNeverAccelerated':True,
        'staticTimeoutWaitingOmittedSeconds':sum(cut['end']-cut['start'] for cut in edit_cuts),
        'mainTimeoutSeconds':60.003,'recordingAttempts':attempts,'allOfficialModelCallsIncludingOmittedAttempts':sum(item['modelCalls'] for item in attempts),
        'allOfficialModelErrorsIncludingOmittedAttempts':[{'directory':item['directory'],**error} for item in attempts for error in item['modelErrors']],
        'mainFullRestSnapshotRetained':False,'mainRestProof':'Actual in-run equality assertions preserved completed stop object, executionEvents, same plan id and exactly +30 pending start/end; failure cleanup did not retain restBefore/restAfter objects',
        'independentTailSetup':'First two stations and final arrival preloaded through real isolated API; final complete clicked on camera; private journey generated automatically',
        'sceneAudioOrigin':'Original main browser had not exported audio before failure. The main brick section uses actual WebAudio from an independent recording of that same current-product element, disclosed in the permanent footer.',
        'subtitleBandCorrections':[{'start':cue['t'],'title':cue['title'],'text':cue['subtitle'],'area':'editorial subtitle band at y982–1051, outside the product viewport'} for cue in cues if cue['title'] in ['到达以后，让地点活起来','刚点的元素，一句就能问']],
        'unshownClaims':['physical-phone/GPS acceptance','WebSpeech sound quality','revisit card upgrades','cross-day automatic expansion','custom-API successful connection','actual thinking-toggle change','public publication','favorites touch','linked-place button detail browsing','automatic destination handoff on home departure'],
        'featureResults':{'mainPlanCreation':True,'mainRestAndContinue':True,'mainPersonalWords':False,'independentPersonalWords':True,'realPrivatePublication':True,'privateCrossAccountDenied':True,'currentSceneElementQuestion':True}})
    (EVIDENCE/'render-proof.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    return report

parser=argparse.ArgumentParser();parser.add_argument('--preview',action='store_true');parser.add_argument('--reuse-render',action='store_true');parser.add_argument('--repair-legacy-burn-in',action='store_true');args=parser.parse_args()
if args.preview:
    cache={}
    for number,cue in enumerate(cues):
        end=cues[number+1]['t'] if number+1<len(cues) else DURATION
        t=cue['t']+min(5,(end-cue['t'])*.6)
        compose(min(TOTAL_FRAMES-1,round(t*FPS)),cache).save(EVIDENCE/f'preview-{number:02d}-{round(t):03d}s.png')
    write_srt();report=proof();print(json.dumps({'previewFrames':len(cues),'seconds':DURATION,'chapterStarts':[(c['name'],c['start']) for c in report['chapters']],'modelCallsInFilm':record['modelCalls'],'allOfficialModelCalls':report['allOfficialModelCallsIncludingOmittedAttempts'],'errors':report['allOfficialModelErrorsIncludingOmittedAttempts']},ensure_ascii=False));
else:
    report=proof(encode(args.reuse_render,args.repair_legacy_burn_in));print(json.dumps({k:report[k] for k in ['video','seconds','sourceAverageFps','realModelCalls','modelErrors','bytes','sha256']},ensure_ascii=False),flush=True)
