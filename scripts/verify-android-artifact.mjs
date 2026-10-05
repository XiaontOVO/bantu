// Read-only APK/source verification; no device, server or application data writes.
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {resolve,join,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {inflateRawSync} from 'node:zlib';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const root=process.cwd(),digest=data=>createHash('sha256').update(data).digest('hex');
const builds=readdirSync('tmp/android-build',{withFileTypes:true}).filter(entry=>entry.isDirectory()).flatMap(entry=>{
  try{return [JSON.parse(readFileSync(join('tmp/android-build',entry.name,'build-proof.json'),'utf8').replace(/^\uFEFF/,''))]}catch{return []}
}).sort((a,b)=>b.builtAt.localeCompare(a.builtAt));
assert.ok(builds.length,'Build the APK first');
const build=builds[0],apk=readFileSync(build.artifact),checks=[];
const check=(name,passed)=>{checks.push({name,passed:!!passed});assert.ok(passed,name)};
const tag=process.argv[2]||'final';assert.match(tag,/^[a-z0-9_-]+$/i);
const output=resolve(`tmp/android-apk-${tag}-artifact-proof.json`);
try{
  check('delivered APK matches signed build hash',digest(apk)===build.sha256);
  check('build records every source input',Array.isArray(build.sourceFiles)&&build.sourceFiles.length>5);
  check('native source inputs still match the signed build',build.sourceFiles.every(source=>{
    const path=resolve(source.path);assert.ok(path.startsWith(resolve(root)+sep),'Source stays in workspace');
    return digest(readFileSync(path))===source.sha256;
  }));
  check('build script matches recorded hash',digest(readFileSync('scripts/build-android.ps1'))===build.buildScriptSha256);
  const entries=[];let end=-1;
  for(let i=apk.length-22;i>=Math.max(0,apk.length-65557);i--)if(apk.readUInt32LE(i)===0x06054b50){end=i;break}
  assert.ok(end>=0,'APK ZIP directory exists');
  let offset=apk.readUInt32LE(end+16);const count=apk.readUInt16LE(end+10);
  for(let index=0;index<count;index++){
    assert.equal(apk.readUInt32LE(offset),0x02014b50);
    const compression=apk.readUInt16LE(offset+10),length=apk.readUInt32LE(offset+20),nameLength=apk.readUInt16LE(offset+28);
    const name=apk.subarray(offset+46,offset+46+nameLength).toString('utf8'),local=apk.readUInt32LE(offset+42);
    const start=local+30+apk.readUInt16LE(local+26)+apk.readUInt16LE(local+28),compressed=apk.subarray(start,start+length);
    const data=compression===8?inflateRawSync(compressed):compressed;
    assert.ok(compression===8||compression===0,'Standard APK entry compression');
    entries.push({name,data});offset+=46+nameLength+apk.readUInt16LE(offset+30)+apk.readUInt16LE(offset+32);
  }
  check('APK has executable classes and manifest',entries.some(e=>e.name==='classes.dex')&&entries.some(e=>e.name==='AndroidManifest.xml'));
  check('no backend, account database, environment file or keystore is bundled',!entries.some(e=>/(?:^|\/)(?:data|src|node_modules|dist|\.env)(?:[/.]|$)|\.(?:sqlite|sqlite3|jks|pem|key)$/i.test(e.name)));
  const secrets=[];
  const collect=value=>{if(!value||typeof value!=='object')return;for(const [name,item]of Object.entries(value)){
    if(/^(?:apiKey|secret|token)$/i.test(name)&&typeof item==='string'&&item.length>=12)secrets.push(item);else collect(item);
  }};
  collect(JSON.parse(readFileSync('data/model-settings.json','utf8')));
  check('configured model secrets are absent from decompressed APK entries',secrets.every(secret=>entries.every(entry=>!entry.data.includes(Buffer.from(secret)))));
  const run=promisify(execFile),java=join(process.env.JAVA_HOME,'bin/java.exe'),tools=resolve('data/android-sdk/build-tools/35.0.0');
  const signed=join(build.buildDirectory,'bantu-debug.apk');
  check('ASCII signing stage equals the delivered APK',digest(readFileSync(signed))===digest(apk));
  const signature=(await run(java,['-jar',join(tools,'lib/apksigner.jar'),'verify','--verbose',signed],{windowsHide:true})).stdout;
  check('Android v2 and v3 signatures verify',/v2.*true/.test(signature)&&/v3.*true/.test(signature));
  const badging=(await run(join(tools,'aapt2.exe'),['dump','badging',signed],{windowsHide:true,maxBuffer:4*1024*1024})).stdout;
  check('packaged application ID and SDK bounds are correct',/package: name='cn.bantu.travel'/.test(badging)&&/^minSdkVersion:'26'$/m.test(badging.replace(/\r/g,''))&&/^targetSdkVersion:'35'$/m.test(badging.replace(/\r/g,'')));
  check('APK is explicitly a test build',/application-debuggable/.test(badging));
  check('no microphone or background location permission',!/android.permission.(?:RECORD_AUDIO|ACCESS_BACKGROUND_LOCATION)/.test(badging));
  const result={artifact:build.artifact,sha256:digest(apk),builtAt:build.builtAt,sourceFiles:build.sourceFiles,entryNames:entries.map(e=>e.name),checks,passed:true,scope:'signed test artifact and exact native source inputs; no functional or real-phone acceptance'};
  writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify({passed:true,checks:checks.length,output}));
}catch(error){writeFileSync(output,JSON.stringify({checks,passed:false,error:error.message},null,2));throw error}
