import assert from 'node:assert/strict';
import {createHttpServer} from '../dist/src/server/http-server.js';
import {MemoryStateStore} from '../dist/src/persistence/state-store.js';
import {createAccessGate} from '../dist/src/server/http/access-gate.js';
import {launchAndroidApp} from './lib/android-app.mjs';
import {mkdirSync,writeFileSync,copyFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
const tag=process.argv[2]||'initial',dir=resolve(`tmp/android-native-auth-${tag}-evidence`);mkdirSync(dir,{recursive:true});
const store=new MemoryStateStore(),gate=createAccessGate({host:'127.0.0.1',code:'BANTUAUTH',bypassLoopback:false});
const server=createHttpServer({seedDemo:false,stateStore:store,accessGate:gate});
const application=server.listeners('request')[0];server.removeAllListeners('request');
server.on('request',(req,res)=>{const authorized=req.headers.authorization===`Basic ${Buffer.from('bantu_native_test:12345678').toString('base64')}`;requests.push({path:req.url,method:req.method,authorized});if(!authorized){res.writeHead(401,{'www-authenticate':'Basic realm="Bantu isolated test"','content-type':'text/plain'});res.end('Authentication required');return;}application(req,res)});
await new Promise(r=>server.listen(0,'127.0.0.1',r));let b;const checks=[],screens=[],requests=[];let phase='native-auth';
const check=(name,value)=>{checks.push({name,passed:!!value});assert.ok(value,name)};
try{
 b=await launchAndroidApp('bantu-native-auth-',{baseUrl:`http://127.0.0.1:${server.address().port}`});
 const tree=async()=>{await b.adb('shell','uiautomator','dump','/sdcard/bantu-auth-ui.xml');return b.adb('shell','cat','/sdcard/bantu-auth-ui.xml')};
 let xml;await b.until(async()=>{xml=await tree();return xml.includes('验证服务访问权限')},'native BasicAuth dialog');
 const save=async name=>{const source=await b.screenshot(name),target=join(dir,name+'.png');copyFileSync(source,target);screens.push(target)};
 await save('01-auth-dialog');
 check('native HTTP auth asks for user credentials',xml.includes('服务访问密码'));
 const editNodes=[...xml.matchAll(/<node[^>]*class="android.widget.EditText"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g)];
 check('credentials use exactly two native input fields',editNodes.length===2);
 const tapBounds=async node=>b.adb('shell','input','tap',String((+node[1]+ +node[3])/2),String((+node[2]+ +node[4])/2));
 await tapBounds(editNodes[0]);await b.adb('shell','input','text','bantu_native_test');
 xml=await tree();const password=[...xml.matchAll(/<node[^>]*class="android.widget.EditText"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g)][1];
 await tapBounds(password);await b.adb('shell','input','text','12345678');
 xml=await tree();const submit=xml.match(/<node[^>]*text="继续"[^>]*resource-id="android:id\/button1"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
 check('native auth has explicit continue control',!!submit);await tapBounds(submit);
 await b.until(()=>b.evaluate('!!document.getElementById("accessCode")'),'invitation after native auth');await save('02-invitation-required');
 phase='gate-api';check('BasicAuth does not bypass invitation',await b.evaluate(`fetch('/api/v1/me').then(async r=>r.status===401&&(await r.json()).error?.code==='ACCESS_CODE_REQUIRED')`));
 phase='gate-fill';await b.fill('#accessCode','BANTUAUTH');phase='gate-submit';await b.tap('button[type=submit]');phase='boot';await b.until(()=>b.evaluate('window.__bantuBooted===true'),'boot behind two independent gates');
 await save('03-authenticated-home');check('same app boots after both explicit validations',await b.evaluate('!!window.BantuNative&&window.__bantuBooted===true'));
 check('no uncaught WebView errors',b.exceptions.length===0);
 check('invitation POST can reauthenticate within this native session',requests.some(r=>r.path==='/access-gate'&&r.method==='POST'&&r.authorized));
 writeFileSync(`tmp/android-native-auth-${tag}-proof.json`,JSON.stringify({tag,checks,screens,requests,isolatedMemory:true,realPhone:false,credentialsFixture:true,credentialsLogged:false},null,2));console.log(JSON.stringify({checks:checks.length,passed:true}));
}catch(error){if(b){const shot=await b.screenshot('auth-failure').catch(()=>null);if(shot){const target=join(dir,'auth-failure.png');copyFileSync(shot,target);screens.push(target)}}writeFileSync(`tmp/android-native-auth-${tag}-proof.json`,JSON.stringify({tag,phase,checks,screens,error:error.message,requests,isolatedMemory:true},null,2));throw error;}
finally{await b?.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
