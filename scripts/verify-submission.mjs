// Submission regressions use each verifier's isolated memory service/profile.
// Two independent browser checks at a time; failures remain in the evidence.
import {spawn} from 'node:child_process';
import {createWriteStream,writeFileSync,mkdirSync,readFileSync,copyFileSync} from 'node:fs';
import {join} from 'node:path';
const namedReport=process.argv.find(argument=>argument.startsWith('--report='))?.slice('--report='.length);
if(namedReport&&!/^[a-z0-9][a-z0-9_-]*$/i.test(namedReport))throw new Error('Report name must use letters, digits, underscores or hyphens.');
const reportName=namedReport||(process.argv.includes('--mobile-final')?'mobile-final-1002':'round2');
const entries=[
 ['search','verify-search-browser.mjs'],
 ['repeat-visits','verify-repeat-progress-ui.mjs'],
 ['repeat-visits-gps','verify-repeat-progress-ui.mjs','--gps'],
 ['cross-day-times','verify-plan-time-carry-ui.mjs'],
 ['draft-recovery','verify-plan-draft-recovery-ui.mjs'],
 ['scheme-comparison','verify-plan-comparison-ui.mjs'],
 ['plan-history','verify-plan-history-ui.mjs'],
 ['map-and-transport','verify-map-ui.mjs'],
 ['image-exit','verify-image-viewer-ui.mjs'],
 ['floorplan-navigation','verify-floorplan-ui.mjs'],
 ['scene-lifecycle','verify-scene-session-ui.mjs'],
 ['scene-navigation','verify-scene-navigation-ui.mjs'],
 ['account-retention','verify-account-retention-ui.mjs'],
 ['post-private','verify-post-visibility-ui.mjs'],
 ['post-interactions','verify-post-interaction-ui.mjs'],
 ['community-reading','verify-community-reading-ui.mjs'],
 ['compact-mode','verify-compact-mode-ui.mjs'],
 ['mobile-layout','verify-mobile-layout-ui.mjs'],
 ['model-settings','verify-model-controls-ui.mjs'],
 ['invitation-gate','verify-access-gate-ui.mjs'],
 ['agent-conversations','verify-agent-conversations-ui.mjs'],
 ['scene-minimal','verify-scene-minimal-ui.mjs'],
 ['plan-alignment','verify-plan-alignment-ui.mjs'],
 ['achievements','verify-achievements-ui.mjs'],
 ['place-details','verify-place-detail-ui.mjs'],
 ['place-card-ratio','verify-place-ratio-ui.mjs'],
 ['chat-composer','verify-chat-composer-ui.mjs'],
];
const logDirectory=join('tmp/submission',reportName);mkdirSync(logDirectory,{recursive:true});
const retry=process.argv.includes('--retry-failed');
const report=retry?JSON.parse(readFileSync(`tmp/submission/${reportName}.json`,'utf8')):{startedAt:new Date().toISOString(),scope:'isolated browser workflows, not field acceptance',results:[]};
const selected=retry?entries.filter(([name])=>report.results.some(r=>r.name===name&&!r.passed)):entries;
const save=()=>writeFileSync(`tmp/submission/${reportName}.json`,JSON.stringify(report,null,2));
async function execute([name,script,...args]){
 console.log('START '+name);const started=Date.now(),log=join(logDirectory,name+'.log');
 const previous=report.results.find(r=>r.name===name);
 if(previous){const archived=join(logDirectory,`${name}.attempt-${(previous.previousAttempts||[]).length+1}.log`);copyFileSync(previous.log,archived);previous.log=archived;}
 const stream=createWriteStream(log);
 const child=spawn(process.execPath,[join('scripts',script),...args],{windowsHide:true,stdio:['ignore','pipe','pipe']});
 child.stdout.pipe(stream,{end:false});child.stderr.pipe(stream,{end:false});
 let timedOut=false;const timer=setTimeout(()=>{timedOut=true;child.kill()},240000);
 const result=await new Promise(resolve=>{child.once('error',error=>resolve({code:null,error:error.message}));child.once('close',(code,signal)=>resolve({code,signal}))});
 clearTimeout(timer);await new Promise(resolve=>stream.end(resolve));
 const latest={name,command:['node','scripts/'+script,...args].join(' '),...result,timedOut,passed:result.code===0&&!timedOut,durationMs:Date.now()-started,log,...(previous?{previousAttempts:[...(previous.previousAttempts||[]),{...previous,previousAttempts:undefined}]}:{})};
 report.results=report.results.filter(r=>r.name!==name);report.results.push(latest);save();console.log((result.code===0&&!timedOut?'PASS ':'FAIL ')+name);
}
let cursor=0;await Promise.all(Array.from({length:2},async()=>{while(cursor<selected.length){const entry=selected[cursor++];if(retry)copyFileSync(join(logDirectory,entry[0]+'.log'),join(logDirectory,entry[0]+'.previous.log'));await execute(entry)}}));
report.finishedAt=new Date().toISOString();report.passed=report.results.every(result=>result.passed);save();console.log(JSON.stringify({passed:report.passed,workflows:report.results.length,failures:report.results.filter(result=>!result.passed).map(result=>result.name)}));
if(!report.passed)process.exitCode=1;
