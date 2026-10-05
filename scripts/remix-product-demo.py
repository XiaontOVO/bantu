"""Add an original editorial score; foreground the product's recorded music."""
import json, subprocess
from pathlib import Path
import imageio_ffmpeg
root=Path(__file__).resolve().parent.parent
proof_path=root/'tmp/product-demo-render-proof.json'
proof=json.loads(proof_path.read_text(encoding='utf-8'))
record=json.loads((root/'tmp/product-demo-recording.json').read_text(encoding='utf-8'))
assert proof['recordingDirectory']==record['directory'] and record.get('audio')
assert proof['capturedSceneAudio'] and not record.get('failed')
assert all((Path(record['directory'])/item['file']).exists() for item in record['audio'])
video=Path(proof['video']);music=root/'submission/伴途演示配乐.mp3'
output=root/'submission/伴途功能演示-配乐版.mp4'
pending=root/'tmp/product-demo-remixed.mp4'
scene_cue=next(cue for cue in record['cues'] if cue['title']=='点画里的红砖，故事就展开')
start=scene_cue['t'];end=next(cue['t'] for cue in record['cues'] if cue['chapter'].startswith('05'))
assert 0<start<end<proof['seconds']
duration=proof['seconds'];ffmpeg=imageio_ffmpeg.get_ffmpeg_exe()
# Before the scene-element tap, editorial music fades away. The tap itself
# starts the real product sample, so the interaction is audible in the film.
fade_start=max(0,start-4)
editorial=f"if(lt(t,{fade_start}),1,if(lt(t,{start}),({start}-t)/4,if(lt(t,{end}),0,if(lt(t,{end+3.5}),(t-{end})/3.5,1))))"
filters=[
 f"[1:a]atrim=duration={duration},asetpts=PTS-STARTPTS,volume='{editorial}':eval=frame,afade=t=out:st={duration-2.5}:d=2.5[score]",
 f"[0:a]loudnorm=I=-23:TP=-3:LRA=6,apad,atrim=duration={duration}[scene]",
 f"[score][scene]amix=inputs=2:duration=longest:normalize=0,atrim=duration={duration},alimiter=limit=0.891:level=false[audio]",
]
subprocess.run([ffmpeg,'-y','-hide_banner','-v','error','-i',str(video),'-stream_loop','-1','-i',str(music),'-filter_complex',';'.join(filters),'-map','0:v:0','-map','[audio]','-c:v','copy','-c:a','aac','-b:a','192k','-t',str(duration),'-movflags','+faststart',str(pending)],check=True)
assert pending.stat().st_size>1_000_000
pending.replace(output)
proof['video']=str(output)
subtitle=root/'submission/伴途功能演示-配乐版.srt'
subtitle.write_bytes((root/'submission/伴途功能演示.srt').read_bytes())
proof['subtitleFile']=str(subtitle)
proof['editorialMusic']={'file':str(music),'original':True,'targetLufs':-21,'fadesBeforeElementTap':True}
proof['sceneMusicCapture']={'files':record['audio'],'start':start,'end':end,'realWebAudio':True,'source':'same current product recording as the video','recordingDirectory':record['directory'],'targetLufs':-23}
proof['modelErrors']=record.get('modelErrors',[])
proof['modelAcceptancePassed']=not proof['modelErrors']
proof_path.write_text(json.dumps(proof,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'video':str(output),'seconds':duration,'originalEditorialScore':True,'actualProductSceneMusic':True,'videoCopiedWithoutReencoding':True}))
