"""Decode and inspect the delivered complete film; never conflate errors with QA."""
import hashlib, json, re, subprocess, sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT=Path(__file__).resolve().parent.parent
sys.path.insert(0,str(ROOT/'tmp/video-runtime'))
import imageio_ffmpeg
sys.stdout.reconfigure(encoding='utf-8')
FFMPEG=imageio_ffmpeg.get_ffmpeg_exe()
OUT=ROOT/'tmp/complete-demo-video';OUT.mkdir(parents=True,exist_ok=True)
render=json.loads((OUT/'render-proof.json').read_text(encoding='utf-8'))
video=Path(render['video']);subtitle=Path(render['subtitle'])
assert video.exists() and subtitle.exists(),'Encode the film before media verification'
checks=[]
def check(name,value,details=None):
    assert value,name
    checks.append({'name':name,'passed':True,**({'details':details} if details is not None else {})})

probe=subprocess.run([FFMPEG,'-hide_banner','-i',str(video)],capture_output=True,text=True,encoding='utf-8',errors='replace').stderr
(OUT/'verify-streams.log').write_text(probe,encoding='utf-8')
check('H264 1920×1080 at 30fps',bool(re.search(r'Video: h264[^\n]*1920x1080[^\n]*30 fps',probe)))
check('AAC audio at 48000Hz',bool(re.search(r'Audio: aac[^\n]*48000 Hz',probe)))
sha=hashlib.sha256(video.read_bytes()).hexdigest()
check('Delivered SHA256 equals final render proof',sha==render['sha256'])
check('Delivered bytes equal final render proof',video.stat().st_size==render['bytes'])

with (OUT/'verify-full-decode.log').open('w',encoding='utf-8') as log:
    decode=subprocess.run([FFMPEG,'-hide_banner','-v','info','-i',str(video),'-vf','showinfo','-af','volumedetect','-f','null','-'],stdout=subprocess.DEVNULL,stderr=log)
decoded=(OUT/'verify-full-decode.log').read_text(encoding='utf-8')
check('Entire video/audio decodes without error',decode.returncode==0 and not re.search(r'Error while|Invalid data found|corrupt decoded',decoded))
frame_numbers=[int(n) for n in re.findall(r'\[Parsed_showinfo[^\]]*\]\s+n:\s*(\d+)',decoded)]
check('All 19765 expected frames actually decoded',len(frame_numbers)==render['frames'] and frame_numbers==list(range(render['frames'])),{'decodedFrames':len(frame_numbers),'renderFrames':render['frames']})
mean_match=re.search(r'mean_volume:\s*(-?[\d.]+) dB',decoded)
peak_match=re.search(r'max_volume:\s*(-?[\d.]+) dB',decoded)
assert mean_match and peak_match,'Audio volume measurement missing'
mean,peak=float(mean_match[1]),float(peak_match[1])
check('Movie audio is audible and not clipped',-48<mean<-8 and peak<-0.05,{'meanRmsDbfs':mean,'samplePeakDbfs':peak})

def seconds(stamp):
    hours,minutes,secs,millis=map(int,re.split('[:,]',stamp))
    return hours*3600+minutes*60+secs+millis/1000
srt=subtitle.read_text(encoding='utf-8-sig').strip()
entries=[]
for block in re.split(r'\r?\n\s*\r?\n',srt):
    match=re.match(r'(\d+)\r?\n(\d\d:\d\d:\d\d,\d\d\d) --> (\d\d:\d\d:\d\d,\d\d\d)\r?\n(.+)',block,re.S)
    assert match,'Malformed SRT block'
    entries.append({'number':int(match[1]),'start':seconds(match[2]),'end':seconds(match[3]),'text':match[4]})
check('All 33 subtitle entries exist and are sequenced',len(entries)==render['subtitleCues'] and [e['number'] for e in entries]==list(range(1,len(entries)+1)))
check('Subtitle intervals stay continuous and cover the film',entries[0]['start']==0 and all(0<e['end']-e['start'] for e in entries) and all(abs(a['end']-b['start'])<=.002 for a,b in zip(entries,entries[1:])) and abs(entries[-1]['end']-render['seconds'])<.002)
check('Subtitles disclose main timeout and independent samples',any('60秒超时' in e['text'] for e in entries) and any('新服务' in e['text'] or '独立' in e['text'] for e in entries))
check('Failed official API call remains in evidence',len(render['allOfficialModelErrorsIncludingOmittedAttempts'])==1 and render['allOfficialModelErrorsIncludingOmittedAttempts'][0]['code']=='MODEL_TIMEOUT')
check('Sources remain isolated and protected configuration unchanged',render['isolatedData'] and render['protectedConfigurationUnchanged'] and render['simulatedGpsAndClock'] and not render['simulatedRoads'])
check('Actual film is identified as mobile webpage, with no device speech capture claim',not render['capturedWebSpeech'] and 'browser' in render['sourceKind'])
check('Static waits are declared as edits, actions are not accelerated',bool(render['editCuts']) and render['shownOperationsNaturalSpeed'] and render['modelWaitsNeverAccelerated'])
main_source=next(item for item in render['sourceRecordings'] if item['role'].startswith('continuous-main'))
main_timeline=json.loads((Path(main_source['directory'])/'timeline.json').read_text(encoding='utf-8'))
check('Walking and driving use genuine multi-point provider geometry',all(any(road['mode']==mode and road['geometryPoints']>2 and not road['errorCode'] for road in main_timeline['roadResults']) for mode in ['walking','driving']))
end_source=next(item for item in render['sourceRecordings'] if item['role'].endswith('new-conversation-and-end'))
saved_path=Path(end_source['directory'])/'actual-isolated-state.json'
saved_bytes=saved_path.read_bytes()
saved=json.loads(saved_bytes.decode('utf-8'))
accounts=json.loads(saved['bantu-trip-service:accounts'])
check('Privacy observer is an actually registered distinct account',len(accounts)==2 and len({a['actorId'] for a in accounts})==2 and {a['username'] for a in accounts}=={'bantu_complete_film','bantu_complete_observer'})
plans=json.loads(saved['bantu-trip-service:plan-library']);independent_plan=plans[0]
# The persisted stops are the planned baseline. Product read APIs replay the
# append-only events; checking raw stop.status incorrectly rejects real progress.
# Invoke that same pure domain replay offline, never rewriting the saved state.
replay_code="""
import fs from 'node:fs';
import { replayExecutionEvents } from './dist/src/domain/execution.js';
const saved = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
const plan = JSON.parse(saved['bantu-trip-service:plan-library'])[0];
const replay = replayExecutionEvents(plan.stops.map(stop => ({ ...stop, status: 'planned' })), plan.executionEvents || []);
console.log(JSON.stringify({ errors: replay.errors, effectiveEventCount: replay.effectiveEvents.length,
  stops: replay.stops.map(stop => ({ stopId: stop.stopId, status: stop.status })) }));
"""
replayed=subprocess.run(['node','--input-type=module','-e',replay_code,str(saved_path)],cwd=ROOT,capture_output=True,text=True,encoding='utf-8',check=True)
derived=json.loads(replayed.stdout)
events=independent_plan['executionEvents']
event_groups=[[event['type'] for event in events if event['stopId']==stop['stopId']] for stop in independent_plan['stops']]
check('Independent plan retains nine actual API/UI progress events',len(plans)==1 and independent_plan['id']=='plan_d2b5abcc-bb6d-4c98-a0a4-9b6d001b8ab4' and len(events)==9 and len({event['executionEventId'] for event in events})==9 and all(event['planId']==independent_plan['id'] for event in events) and all(group==['depart','arrive','complete'] for group in event_groups))
check('Actual domain replay derives three completed stations without errors',derived['effectiveEventCount']==9 and not derived['errors'] and len(derived['stops'])==3 and all(stop['status']=='completed' for stop in derived['stops']),derived)
check('Offline progress verification leaves the saved isolated state unchanged',saved_path.read_bytes()==saved_bytes)
(OUT/'verify-derived-progress.json').write_text(json.dumps({'snapshot':str(saved_path),'snapshotSha256':hashlib.sha256(saved_bytes).hexdigest(),'planId':independent_plan['id'],'rawBaselineStatuses':[stop['status'] for stop in independent_plan['stops']],'eventGroups':event_groups,'replay':derived},ensure_ascii=False,indent=2),encoding='utf-8')
memory_map=json.loads(saved['bantu-trip-service:personal-memories']);memories=[memory for group in memory_map.values() for memory in group]
check('One original private memory retains exact words and all three places',len(memories)==1 and memories[0]['memoryId']=='memory_8b62e8dc-8600-4ca0-90a1-3889a8287925' and '休息之后，才看清武康大楼街角的光影' in memories[0]['userText'] and len(memories[0]['journey']['places'])==3)
posts=json.loads(saved['bantu-trip-service:community'])['posts']
check('The film really publishes one private post, without duplicates',len(posts)==1 and posts[0]['id']=='post_9104a089-4805-4b63-97f9-2a92521ece14' and posts[0]['visibility']=='private' and posts[0]['text'].startswith('休息之后，旅途更从容\n'))
labels={entry['label'] for entry in render['checks'] if entry['passed']}
for label in ['rest keeps the exact original plan id','rest preserves completed station','rest preserves execution facts',
              'rest shifts only pending stations exactly thirty minutes','floorplan has distinct restroom legend',
              'closing floor image returns to selected second floor','actual private publication saved exact title',
              'second account cannot read private publication by id','second account public feed excludes private publication',
              'scene conversation retains actual element context','scene question receives a relevant real answer',
              'new conversation opens an independent empty history']:
    check('Retained actual action/result: '+label,label in labels)

# These PNGs are extracted from the final encoded MP4, never from previews.
times=[('opening',5),('discovery',27),('plan-query',141),('actual-roads',207),('landscape-element',236),
       ('scene-real-answer',303),('rest-receipt',335),('floor-material',381),('main-timeout',448),
       ('independent-personal-words',502),('real-private-title-and-owner',549.53),('private-result',568),
       ('achievement-source',582),('custom-service-entry',623),('new-empty-conversation',646)]
frames=[]
for label,time in times:
    target=OUT/f'verify-encoded-{time:07.2f}-{label}.png'
    subprocess.run([FFMPEG,'-y','-hide_banner','-v','error','-ss',str(time),'-i',str(video),'-frames:v','1',str(target)],check=True)
    frame=Image.open(target);check('Encoded frame dimensions: '+label,frame.size==(1920,1080))
    frames.append({'label':label,'seconds':time,'path':str(target)})
font=ImageFont.truetype('C:/Windows/Fonts/msyh.ttc',18)
sheet=Image.new('RGB',(1920,5*395),'#eef2f8');draw=ImageDraw.Draw(sheet)
for index,entry in enumerate(frames):
    x=(index%3)*640;y=(index//3)*395
    draw.text((x+12,y+5),f"{entry['seconds']:.2f}s · {entry['label']}",fill='#243148',font=font)
    sheet.paste(Image.open(entry['path']).resize((640,360),Image.Resampling.LANCZOS),(x,y+32))
contact=OUT/'verify-encoded-contact-sheet.png';sheet.save(contact)

audio_sections=[]
for index,window in enumerate(render['actualSceneAudio']):
    length=min(8,window['end']-window['start']-1)
    assert length>0
    measurement=subprocess.run([FFMPEG,'-hide_banner','-v','info','-ss',str(window['start']+.5),'-i',str(video),'-t',str(length),'-vn','-af','volumedetect','-f','null','-'],capture_output=True,text=True,encoding='utf-8',errors='replace').stderr
    (OUT/f'verify-scene-audio-{index}.log').write_text(measurement,encoding='utf-8')
    measured=re.search(r'mean_volume:\s*(-?[\d.]+) dB',measurement);assert measured
    rms=float(measured[1]);check('Actual scene audio window is audible: '+str(index),rms>-48)
    audio_sections.append({**window,'meanRmsDbfs':rms})

chapter_audio=[]
for chapter in render['chapters']:
    start=chapter['start']+(chapter['end']-chapter['start'])*.45
    length=min(4,chapter['end']-start)
    result=subprocess.run([FFMPEG,'-hide_banner','-v','info','-ss',str(start),'-i',str(video),'-t',str(length),'-vn','-af','volumedetect','-f','null','-'],capture_output=True,text=True,encoding='utf-8',errors='replace')
    (OUT/f'verify-chapter-audio-{chapter["number"]:02d}.log').write_text(result.stderr,encoding='utf-8')
    measured=re.search(r'mean_volume:\s*(-?[\d.]+) dB',result.stderr);assert measured
    rms=float(measured[1]);check('BGM audible in chapter '+str(chapter['number']),result.returncode==0 and rms>-48)
    chapter_audio.append({'number':chapter['number'],'name':chapter['name'],'start':start,'length':length,'meanRmsDbfs':rms})

report={'passed':True,'video':str(video),'sha256':sha,'bytes':video.stat().st_size,'seconds':render['seconds'],
        'decodedFrames':len(frame_numbers),'width':1920,'height':1080,'fps':30,'audioMeanRmsDbfs':mean,'audioSamplePeakDbfs':peak,
        'subtitleEntries':len(entries),'encodedFrames':frames,'encodedContactSheet':str(contact),'actualSceneAudioMeasurements':audio_sections,'chapterAudioMeasurements':chapter_audio,
        'sourceAverageFps':render['sourceAverageFps'],'sourceFrameGapP95':render['sourceFrameGapP95'],'sourceFrameGapMax':render['sourceFrameGapMax'],
        'officialModelCallsAllAttempts':render['allOfficialModelCallsIncludingOmittedAttempts'],'officialModelErrors':render['allOfficialModelErrorsIncludingOmittedAttempts'],
        'checks':checks,'qaScope':'Media format, full decode, audio, subtitle times, and retained action evidence. Actual encoded PNGs must also be visually reviewed. One real model timeout remains disclosed; this is not zero-error product certification.'}
(OUT/'verify-proof.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({key:report[key] for key in ['passed','seconds','decodedFrames','subtitleEntries','audioMeanRmsDbfs','audioSamplePeakDbfs','sha256']},ensure_ascii=False))
