"""Original instrumental score for the film; no downloaded samples or music."""
import wave, subprocess, json
from pathlib import Path
import numpy as np
import imageio_ffmpeg
root=Path(__file__).resolve().parent.parent
rate=44100;tempo=92;beat=60/tempo;bars=32;duration=bars*4*beat+2
song=np.zeros((round(duration*rate),2),np.float64)
rng=np.random.default_rng(172)
def hz(midi):return 440*2**((midi-69)/12)
def add(at,length,frequency,gain,pan=0,kind='keys'):
 start=round(at*rate);n=min(round(length*rate),len(song)-start)
 if n<=0:return
 t=np.arange(n)/rate
 attack=np.minimum(1,t/.018)
 if kind=='pad':
  env=np.minimum(1,t/.5)*np.minimum(1,(length-t)/.65)
  tone=np.sin(2*np.pi*frequency*t)+.12*np.sin(2*np.pi*frequency*2.002*t)
 elif kind=='bass':
  env=attack*np.exp(-t*2.1/length)
  tone=np.sin(2*np.pi*frequency*t)+.16*np.sin(4*np.pi*frequency*t)
 elif kind=='kick':
  env=np.exp(-t*21);tone=np.sin(2*np.pi*(52*t+24*(1-np.exp(-t*30))/30))
 elif kind=='brush':
  env=np.exp(-t*62);noise=rng.normal(0,.3,n);tone=np.diff(noise,prepend=0)
 else:
  env=attack*np.exp(-t*3.4/length)
  tone=np.sin(2*np.pi*frequency*t)+.24*np.sin(4*np.pi*frequency*t)*np.exp(-t*3)+.075*np.sin(6*np.pi*frequency*t)*np.exp(-t*6)
 tail=np.minimum(1,(length-t)/.08)
 signal=tone*env*tail*gain
 song[start:start+n,0]+=signal*np.sqrt((1-pan)/2)
 song[start:start+n,1]+=signal*np.sqrt((1+pan)/2)
# G – D – Em – C, with open voicings and a two-bar melodic motif.
chords=[(43,[55,59,62,67]),(38,[54,57,62,66]),(40,[55,59,64,67]),(36,[55,60,64,67])]
melody=[(0,71,.75),(.75,74,.75),(1.5,79,1),(2.5,74,.75),(3.25,71,.75),(4,69,1),(5,67,1.5),(6.5,69,.5),(7,71,1)]
for bar in range(bars):
 base=bar*4*beat;bass,notes=chords[bar%4]
 if bar>=2:
  for note in notes:add(base,beat*4,hz(note),.018,pan=(note%3-1)*.35,kind='pad')
 add(base,beat*2.8,hz(bass),.18,kind='bass')
 add(base+2*beat,beat*1.6,hz(bass+12),.085,kind='bass')
 for step in range(8):
  note=notes[(step+bar%2)%4]
  add(base+step*beat/2,beat*1.35,hz(note),.045 if step%2 else .063,pan=(-.32 if step%2 else .32))
 if bar>=4 and bar%2==0:
  for offset,note,length in melody:
   # A higher answering phrase in the final eight bars.
   shift=12 if bar>=24 and offset>=4 else 0
   add(base+offset*beat,length*beat*1.2,hz(note+shift),.083,pan=-.08)
 if 8<=bar<30:
  for offset in [0,2]:add(base+offset*beat,.21,0,.085,kind='kick')
  for offset in np.arange(.5,4,.5):add(base+offset*beat,.09,0,.025,pan=.4,kind='brush')
dry=song.copy()
for seconds,gain,swap in [(.113,.12,True),(.227,.075,False),(.373,.04,True)]:
 delay=round(seconds*rate);song[delay:]+=dry[:-delay,::-1] *gain if swap else dry[:-delay]*gain
song*=np.minimum(1,np.arange(len(song))/(rate*1.6))[:,None]
song*=np.minimum(1,(len(song)-np.arange(len(song)))/(rate*2.5))[:,None]
song*=.78/max(.01,np.max(np.abs(song)))
raw=root/'tmp/demo-original-score.wav'
with wave.open(str(raw),'wb') as out:
 out.setnchannels(2);out.setsampwidth(2);out.setframerate(rate);out.writeframes((song*32767).astype('<i2').tobytes())
output=root/'submission/伴途演示配乐.mp3'
subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(),'-y','-v','error','-i',str(raw),'-af','loudnorm=I=-21:TP=-2:LRA=6','-ar','44100','-c:a','libmp3lame','-b:a','192k','-metadata','title=伴途 · 轻步','-metadata','comment=原创代码作曲与合成，无外部采样',str(output)],check=True)
print(json.dumps({'file':str(output),'seconds':duration,'bpm':tempo,'original':True},ensure_ascii=False))
