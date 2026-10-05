"""Compose actual captured frames into a readable 1080p/30fps presentation."""
import json, sys, math, subprocess, bisect
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import numpy as np
import imageio_ffmpeg

root=Path(__file__).resolve().parent.parent
record=json.loads((root/'tmp/product-demo-recording.json').read_text(encoding='utf-8'))
directory=Path(record['directory'])
assert not record.get('failed') and record['realModel'] and record['isolatedData']
frames=[json.loads(line) for line in (directory/'frames.jsonl').read_text().splitlines()]
cues=record['cues'];times=[f['t'] for f in frames];cue_times=[c['t'] for c in cues]
# A separately captured, real-time route demonstration replaces the original
# marker-only map shot. The source is disclosed in the recording proof.
route_report=root/'tmp/product-demo-route.json'
route=None;route_frames=[];route_times=[];route_window=(95.0,111.5)
candidate=json.loads(route_report.read_text(encoding='utf-8')) if route_report.exists() else None
if candidate and candidate.get('primaryRecordingDirectory')==record['directory']:
 route=candidate
 assert not route.get('failed') and route['fixture']
 route_directory=Path(route['directory'])
 route_frames=[json.loads(line) for line in (route_directory/'frames.jsonl').read_text().splitlines()]
 route_times=[f['t'] for f in route_frames]
 assert route['duration']<=route_window[1]-route_window[0], 'Never accelerate route operations'
 cues[7].update(title='出发后，看清全程路线',subtitle='出发后打开地图，点击“全程路线”查看各站。定位和道路为演示数据。',points=['首页记录出发','地图显示各站与全程路线','交通方式可切换'])
touches=[touch for touch in record['touches'] if not route or not route_window[0]<=touch['t']<route_window[1]]
if route:touches += [{**touch,'t':route_window[0]+touch['t']} for touch in route['touches']]
font_root=Path('C:/Windows/Fonts')
def font(size,bold=False): return ImageFont.truetype(str(font_root/('msyhbd.ttc' if bold else 'msyh.ttc')),size)
F={k:font(v,b) for k,v,b in [('brand',44,True),('title',60,True),('landscape',36,True),('body',33,False),('subtitle',34,False),('small',23,False),('step',24,True),('number',156,True)]}
W,H,FPS=1920,1080,30
ink='#20304b';muted='#6c7c91';teal='#365ee8'
def lines(text,f,width):
 out=[];line=''
 for character in text:
  if character=='\n' or f.getlength(line+character)>width:
   out.append(line);line='' if character=='\n' else character
  else:line+=character
 if line:out.append(line)
 return out
def multiline(draw,text,xy,f,width,fill,spacing=12):
 x,y=xy
 for line in lines(text,f,width):draw.text((x,y),line,font=f,fill=fill);y+=f.size+spacing
 return y

yy,xx=np.mgrid[0:H,0:W]
light=np.exp(-((xx-360)**2/(850**2)+(yy-490)**2/(800**2)))
warm=np.exp(-((xx-1780)**2/(700**2)+(yy-100)**2/(700**2)))
pixels=np.zeros((H,W,3),np.float64)+np.array([246,249,252])
pixels+=light[:,:,None]*np.array([-12,-5,1])+warm[:,:,None]*np.array([6,1,-12])
background=Image.fromarray(np.clip(pixels,0,255).astype('uint8'))
d=ImageDraw.Draw(background)
for x in range(84,1880,26):
 for y in range(148,914,26):
  if x<110 or x>1810:d.ellipse((x,y,x+1,y+1),fill='#d9e3ee')
brand_path=root/'tmp/bantu-demo-brand.png'
assert brand_path.exists(),'Run node scripts/render-demo-brand.mjs first'
brand=Image.open(brand_path).convert('RGBA').resize((50,50),Image.Resampling.LANCZOS)
background.paste(brand,(72,33),brand)
d.text((139,29),'伴途',font=F['brand'],fill=ink)
d.text((263,49),'让每一步，跟得上真实旅途',font=F['small'],fill=muted)
d.rounded_rectangle((1515,35,1848,85),radius=24,fill='white',outline='#dce5ef',width=1)
d.ellipse((1535,55,1545,65),fill='#38a58a')
d.text((1560,44),'真实模型 · 手机实录',font=F['small'],fill=muted)
d.line((72,112,1848,112),fill='#dde6ef',width=2)

chapter_names=['发现地点','一句话规划','首页随行','沉浸探索','随时调整','私人回顾','自主分享','旅行成就']
portrait_shadow=Image.new('RGBA',(W,H));shadow_draw=ImageDraw.Draw(portrait_shadow)
shadow_draw.rounded_rectangle((125,161,637,914),radius=34,fill=(28,50,84,35))
portrait_shadow=portrait_shadow.filter(ImageFilter.GaussianBlur(25))

def chrome(cue,landscape):
 canvas=background.copy();d=ImageDraw.Draw(canvas)
 chapter=int(cue['chapter'].split('/')[0])-1
 if not landscape:
  canvas.paste(portrait_shadow,(0,0),portrait_shadow);d=ImageDraw.Draw(canvas)
  # Separate product and editorial panels; no caption covers app controls.
  d.rounded_rectangle((108,140,628,908),radius=34,fill='#20304b')
  d.rounded_rectangle((115,147,621,901),radius=29,fill='white')
  d.rounded_rectangle((726,148,1848,900),radius=32,fill='#ffffff',outline='#e1e8f0',width=1)
  d.text((1550,170),f'{chapter+1:02}',font=F['number'],fill='#f1f5fe')
  d.rounded_rectangle((771,211,957,257),radius=22,fill='#edf2ff')
  d.text((792,218),cue['chapter'],font=F['step'],fill=teal)
  d.text((977,218),chapter_names[chapter],font=F['step'],fill=muted)
  y=multiline(d,cue['title'],(771,298),F['title'],990,ink,15)+43
  for i,point in enumerate(cue['points']):
   assert F['body'].getlength(point)<=886,point
   d.ellipse((774,y+3,815,y+44),fill='#eef3ff')
   d.text((786,y+8),str(i+1),font=font(20,True),fill=teal)
   d.text((843,y+1),point,font=F['body'],fill=ink)
   if i<len(cue['points'])-1:d.line((843,y+64,1765,y+64),fill='#edf1f6',width=1)
   y+=88
  assert y<800,'Editorial points collide with footer'
  d.line((771,822,1778,822),fill='#e4ebf3',width=1)
  d.text((771,846),'规划  /  随行  /  探索  /  调整  /  回顾',font=F['small'],fill=muted)
 else:
  d.rounded_rectangle((80,136,1840,904),radius=28,fill='white',outline='#dce5ef',width=2)
 # Readable, permanently burned-in Chinese subtitles.
 for i,name in enumerate(chapter_names):
  x=72+i*224;active=i==chapter
  d.rounded_rectangle((x,921,x+205,927),radius=3,fill=teal if active else '#dce5ef')
  d.text((x,935),f'{i+1:02}  {name}',font=font(17,active),fill=teal if active else muted)
 d.rounded_rectangle((72,964,1848,1046),radius=20,fill='white',outline='#e2e9f1',width=1)
 subtitle_lines=lines(cue['subtitle'],F['subtitle'],1696)
 assert len(subtitle_lines)<=2, cue['subtitle']
 y=965 if len(subtitle_lines)>1 else 985
 for line in subtitle_lines:
  d.text(((W-F['subtitle'].getlength(line))/2,y),line,font=F['subtitle'],fill=ink);y+=46
 d.text((73,1056),'移动端浏览器实录 · 定位 / 道路 / 时钟为演示数据',font=font(16),fill=muted)
 d.text((1570,1056),'1080p · 30 FPS · 中文字幕',font=font(16),fill=muted)
 return canvas

output=root/'submission/伴途功能演示.mp4';pending=root/'submission/伴途功能演示.pending.mp4'
preview='--preview' in sys.argv
ffmpeg=imageio_ffmpeg.get_ffmpeg_exe()
args=[ffmpeg,'-y','-hide_banner','-loglevel','error','-f','rawvideo','-pix_fmt','rgb24','-s',f'{W}x{H}','-r',str(FPS),'-i','pipe:0','-an','-c:v','libx264','-preset','fast','-crf','18','-pix_fmt','yuv420p','-movflags','+faststart',str(pending)]
process=None if preview else subprocess.Popen(args,stdin=subprocess.PIPE,stderr=subprocess.PIPE)
count=math.ceil(record['duration']*FPS);last_index=-1;source=None;cue_index=-1;plate=None;landscape=None
preview_indices=[min(count-1,round((c['t']+3)*FPS)) for c in cues]
if route:preview_indices.append(round(103*FPS))
try:
 for index in (preview_indices if preview else range(count)):
  t=index/FPS;c_index=max(0,bisect.bisect_right(cue_times,t)-1)
  replacing_route=route and route_window[0]<=t<route_window[1]
  selected_frames=route_frames if replacing_route else frames
  selected_times=route_times if replacing_route else times
  selected_directory=route_directory if replacing_route else directory
  source_time=t-route_window[0] if replacing_route else t
  f_index=max(0,bisect.bisect_right(selected_times,source_time)-1)
  frame_key=(bool(replacing_route),f_index)
  if frame_key!=last_index:
   source=Image.open(selected_directory/'frames'/selected_frames[f_index]['file']).convert('RGB');last_index=frame_key
  is_landscape=source.width>source.height
  if c_index!=cue_index or landscape!=is_landscape:
   cue_index=c_index;landscape=is_landscape;plate=chrome(cues[c_index],is_landscape)
  canvas=plate.copy();d=ImageDraw.Draw(canvas)
  if is_landscape:
   box=(90,146,1830,894)
  else:box=(127,159,609,889)
  scale=min((box[2]-box[0])/source.width,(box[3]-box[1])/source.height)
  size=(round(source.width*scale),round(source.height*scale));x=round((box[0]+box[2]-size[0])/2);y=round((box[1]+box[3]-size[1])/2)
  image=source.resize(size,Image.Resampling.LANCZOS);canvas.paste(image,(x,y))
  # Touch rings identify the actual target recorded by the touch dispatcher.
  for touch in touches:
   age=t-touch['t']
   if 0<=age<.85:
    tx=x+touch['x']*size[0];ty=y+touch['y']*size[1];r=13+age*20
    d.ellipse((tx-r,ty-r,tx+r,ty+r),outline=teal,width=4)
    if age<.18:d.ellipse((tx-5,ty-5,tx+5,ty+5),fill=teal)
  d.line((72,1038,1848,1038),fill='#e1e9e4',width=3)
  d.line((72,1038,72+1776*t/record['duration'],1038),fill=teal,width=3)
  if preview:canvas.save(root/f'tmp/demo-preview-{c_index:02}.png')
  else:process.stdin.write(canvas.tobytes())
  if index%(FPS*20)==0:print(json.dumps({'renderSeconds':int(t),'totalSeconds':round(record['duration'])}),flush=True)
 if preview:
  print(json.dumps({'previewFrames':len(preview_indices)}));sys.exit(0)
 process.stdin.close();error=process.stderr.read().decode('utf-8',errors='replace');assert process.wait()==0,error
except BaseException:
 if process:process.kill()
 raise

# Captured WebAudio is the actual in-product scene music. No replacement music or TTS.
if record.get('audio'):
 mux=[ffmpeg,'-y','-hide_banner','-loglevel','error','-i',str(pending)]
 filters=[]
 for i,item in enumerate(record['audio']):
  mux+=['-i',str(directory/item['file'])]
  filters.append(f'[{i+1}:a]volume=3,adelay={round(max(0,item["start"])*1000)}:all=1[a{i}]')
 inputs=''.join(f'[a{i}]' for i in range(len(record['audio'])))
 filters.append(f'{inputs}amix=inputs={len(record["audio"])}:normalize=0,apad,atrim=duration={record["duration"]}[audio]')
 mux+=['-filter_complex',';'.join(filters),'-map','0:v','-map','[audio]','-c:v','copy','-c:a','aac','-b:a','192k','-movflags','+faststart',str(output)]
 subprocess.run(mux,check=True)
else:pending.replace(output)

def stamp(seconds):
 ms=round(seconds*1000);h,ms=divmod(ms,3600000);m,ms=divmod(ms,60000);s,ms=divmod(ms,1000);return f'{h:02}:{m:02}:{s:02},{ms:03}'
srt=[]
for i,cue in enumerate(cues):
 end=cues[i+1]['t'] if i+1<len(cues) else record['duration']
 srt.append(f'{i+1}\n{stamp(cue["t"])} --> {stamp(end)}\n{cue["subtitle"]}\n')
(root/'submission/伴途功能演示.srt').write_text('\n'.join(srt),encoding='utf-8-sig')
proof={'video':str(output),'width':W,'height':H,'fps':FPS,'frames':count,'seconds':count/FPS,'sourceFrames':len(frames),'subtitleCues':len(cues),'realModelCalls':record['modelCalls'],'capturedSceneAudio':bool(record.get('audio')),'source':'actual mobile-browser compositor frames','simulatedGpsAndRoads':True,'isolatedData':True,'recordingDirectory':str(directory)}
if route:proof['routeSupplement']={'directory':str(route_directory),'sourceFrames':len(route_frames),'sourceDuration':route['duration'],'window':route_window,'speed':1,'fixture':True}
(root/'tmp/product-demo-render-proof.json').write_text(json.dumps(proof,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps(proof),flush=True)
