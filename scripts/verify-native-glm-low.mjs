// Read-only, isolated capability probe. Never saves global or user preferences.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {ModelSettings,testModelTools} from '../dist/src/services/model-settings.js';

const file='data/model-settings.json';
const fingerprint=()=>createHash('sha256').update(readFileSync(file)).digest('hex');
const before=fingerprint(),calls=[];
const manager=new ModelSettings(file,undefined,async(url,init)=>{
 const body=JSON.parse(init.body);
 assert.equal(body.model,'glm-5.3-flash');
 assert.deepEqual(body.thinking,{type:'enabled'});
 assert.equal(body.reasoning_effort,'low');
 const response=await fetch(url,init);
 const data=await response.clone().json().catch(()=>({}));
 calls.push({status:response.status,tools:Array.isArray(body.tools)&&body.tools.length>0,
  reasoningTokens:data.usage?.completion_tokens_details?.reasoning_tokens??null,
  hasReasoningContent:Boolean(data.choices?.[0]?.message?.reasoning_content)});
 return response;
});
assert.equal(manager.view().modelName,'glm-5.3-flash');
const provider=manager.provider.withThinking('on','low');
const proof={testedAt:new Date().toISOString(),model:'glm-5.3-flash',isolatedThinking:'on',effort:'low',calls};
try{
 await testModelTools(provider);proof.toolRoundTrip=true;
 const response=await provider.generateTurn({messages:[{role:'user',content:'请用一句话介绍武康大楼的外观特色，不要调用工具。'}],tools:[],maxOutputTokens:512,timeoutMs:30000});
 assert.equal(response.error,undefined,response.error?.code);
 assert.ok(response.text.trim().length>10,'No useful plain-text introduction');
 assert.equal(response.toolCalls.length,0);
 proof.plainIntroduction=true;proof.passed=true;
}catch(error){proof.passed=false;proof.error=error.message;process.exitCode=1;}
finally{
 proof.officialConfigUnchanged=fingerprint()===before;
 assert.ok(proof.officialConfigUnchanged,'Official config must remain unchanged');
 writeFileSync('tmp/native-glm-low-proof.json',JSON.stringify(proof,null,2));
 console.log(JSON.stringify(proof,null,2));
}
