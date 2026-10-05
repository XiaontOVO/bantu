"""Decode the delivered video and extract real encoded frames for visual QA."""
import json, re, subprocess
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFont
import imageio_ffmpeg

root=Path(__file__).resolve().parent.parent
proof=json.loads((root/'tmp/product-demo-render-proof.json').read_text(encoding='utf-8'))
record=json.loads((root/'tmp/product-demo-recording.json').read_text(encoding='utf-8'))
assert proof['recordingDirectory']==record['directory'] and not record.get('failed')
video=Path(proof['video']);ffmpeg=imageio_ffmpeg.get_ffmpeg_exe()
assert video.exists() and video.stat().st_size>1_000_000
info=subprocess.run([ffmpeg,'-hide_banner','-i',str(video)],capture_output=True).stderr.decode('utf-8',errors='replace')
assert '1920x1080' in info and '30 fps' in info and 'h264' in info and 'aac' in info,info
decoded=subprocess.run([ffmpeg,'-hide_banner','-v','error','-xerror','-i',str(video),'-map','0:v:0','-map','0:a:0','-progress','pipe:1','-f','null','-'],capture_output=True)
assert decoded.returncode==0,decoded.stderr.decode('utf-8',errors='replace')
frame_counts=re.findall(r'^frame=(\d+)$',decoded.stdout.decode(),re.M)
assert frame_counts and int(frame_counts[-1])==proof['frames'],frame_counts[-1:]
srt=Path(proof.get('subtitleFile',root/'submission/伴途功能演示.srt')).read_text(encoding='utf-8-sig').strip().split('\n\n')
assert len(srt)==proof['subtitleCues']==len(record['cues'])
def seconds(stamp):
 h,m,s,ms=map(int,re.split('[:,]',stamp));return h*3600+m*60+s+ms/1000
previous=0
for i,block in enumerate(srt):
 rows=block.splitlines();assert rows[0]==str(i+1) and len(rows)>=3
 start,end=map(seconds,rows[1].split(' --> '))
 assert end>start and abs(start-previous)<.04
 previous=end
assert abs(previous-proof['seconds'])<.04
source_rates=[]
directories=[proof['recordingDirectory']]
if proof.get('routeSupplement'):directories.append(proof['routeSupplement']['directory'])
for directory in directories:
 folder=Path(directory);timeline=json.loads((folder/'timeline.json').read_text(encoding='utf-8'))
 frames=[json.loads(line) for line in (folder/'frames.jsonl').read_text(encoding='utf-8').splitlines()]
 rate=len(frames)/timeline['duration'];assert rate>30
 source_rates.append(round(rate,2))
sound=subprocess.run([ffmpeg,'-v','error','-i',str(video),'-vn','-ac','1','-ar','16000','-f','s16le','pipe:1'],capture_output=True,check=True)
pcm=np.frombuffer(sound.stdout,dtype='<i2').astype(float)
scene_cue=next(cue for cue in record['cues'] if cue['title']=='点画里的红砖，故事就展开')
scene_at=scene_cue['t']+5
scene_rms=float(np.sqrt(np.mean(pcm[round(scene_at*16000):round((scene_at+3)*16000)]**2)))
assert scene_rms>5 and np.max(np.abs(pcm))<32760
music_windows={}
if proof.get('editorialMusic'):
 for chapter in ['01','02','03','05','06','07','08']:
  cue=next(cue for cue in record['cues'] if cue['chapter'].startswith(chapter))
  label=cue['title'];at=cue['t']+5
  rms=float(np.sqrt(np.mean(pcm[round(at*16000):round((at+3)*16000)]**2)))
  assert rms>150,(label,rms)
  music_windows[label]=round(rms,2)
 assert scene_rms>150,'the element tap must lead to clearly audible music'
output=root/'tmp/demo-video-qa';output.mkdir(exist_ok=True)
titles=['伴途 · 跟得上真实旅途','看见真实的执行结果','出发后，看清全程路线','点画里的红砖，故事就展开','修改完成，接着原来的旅途','一天结束，自动连起旅行足迹','公开还是私密，由你决定','每一次相遇，点亮一张卡','伴途，让每一步跟上真实旅途']
shots=[]
for title in titles:
 cue=next(cue for cue in record['cues'] if cue['title']==title);i=record['cues'].index(cue)
 end=record['cues'][i+1]['t'] if i+1<len(record['cues']) else record['duration']
 offset=(end-cue['t'])*.65 if title=='出发后，看清全程路线' else min(8,(end-cue['t'])*.75)
 at=cue['t']+offset
 shots.append((at,title))
contact=Image.new('RGB',(1920,860),'#eef5f0');draw=ImageDraw.Draw(contact)
font=ImageFont.truetype('C:/Windows/Fonts/msyh.ttc',22)
for i,(at,label) in enumerate(shots):
 path=output/f'{at:06.2f}.png'
 subprocess.run([ffmpeg,'-y','-v','error','-ss',str(at),'-i',str(video),'-frames:v','1',str(path)],check=True)
 image=Image.open(path);assert image.size==(1920,1080)
 x=(i%3)*640;y=(i//3)*286
 contact.paste(image.resize((448,252),Image.Resampling.LANCZOS),(x+96,y+32))
 draw.text((x+96,y+2),f'{at:.1f}s · {label}',font=font,fill='#193c39')
contact.save(output/'contact.png')
result={'video':str(video),'decodePassed':True,'frames':int(frame_counts[-1]),'seconds':proof['seconds'],'resolution':'1920x1080','fps':30,'subtitles':len(srt),'sourceFps':source_rates,'sceneAudioRms':round(scene_rms,2),'encodedFrames':str(output),'bytes':video.stat().st_size}
result['editorialMusicWindows']=music_windows
result['modelCalls']=record['modelCalls']
result['modelErrors']=record.get('modelErrors',[])
result['modelAcceptancePassed']=not result['modelErrors']
(root/'tmp/product-demo-video-qa.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(result))
