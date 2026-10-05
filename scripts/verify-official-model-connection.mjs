// The replacement key comes only from the process environment, never from this script or logs.
import {ModelSettings} from '../dist/src/services/model-settings.js';
const key=process.env.BANTU_OFFICIAL_REPLACEMENT_KEY;
if(!key)throw new Error('Replacement key must be supplied in the process environment.');
const settings=new ModelSettings('data/model-settings.json');
try{
 const result=await settings.test({baseUrl:'https://open.bigmodel.cn/api/paas/v4',modelName:'glm-5.3-flash',apiKey:key,thinking:'off',thinkingFormat:'thinking-type',apiFormat:'chat-completions'},true);
 console.log(JSON.stringify({tested:result.tested,enabled:result.enabled,modelName:result.modelName,thinking:result.thinking,toolRoundTrip:true}));
}catch(error){console.error(String(error.message).replaceAll(key,'[redacted]'));process.exitCode=1}
