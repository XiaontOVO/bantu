const quoteClosers: Record<string,string>={'“':'”','「':'」','‘':'’','『':'』','"':'"',"'":"'"};
const wordCharacter=(value:string|undefined)=>/[\p{L}\p{N}]/u.test(value||'');
function quotationEnd(text:string,start:number):number|undefined{
  const opener=text[start],closer=quoteClosers[opener];
  if(!closer)return undefined;
  let depth=1;
  for(let index=start+1;index<text.length;index++){
    if((opener==='"'||opener==="'")&&text[index]==='\\'){index++;continue;}
    if(opener==="'"&&text[index]==="'"&&wordCharacter(text[index-1])&&wordCharacter(text[index+1]))continue;
    if(opener!==closer&&text[index]===opener)depth++;
    if(text[index]===closer&&--depth===0)return index+1;
  }
  return undefined;
}

/** Explicit source text is data; restrictions are read only from the surrounding instruction. */
export function agentInstructionOutsideOriginals(request: string): string {
  const markers=/(?:内容就是|原文是|原文如下|内容如下|exact\s+(?:text|wording)(?:\s+(?:is|as\s+follows))?|original\s+text(?:\s+is)?)\s*[:：]?\s*/gi;
  let result='',cursor=0;
  for(const match of request.matchAll(markers)){
    if(match.index!<cursor)continue;
    const start=match.index!+match[0].length,opener=request[start],closer=({'“':'”','「':'」','‘':'’','『':'』','"':'"',"'":"'"} as Record<string,string>)[opener];
    result+=request.slice(cursor,match.index);
    if(!closer)return result;
    cursor=quotationEnd(request,start)??request.length;
  }
  const text=result+request.slice(cursor),masked=text.split('');
  for(let index=0;index<text.length;index++){
    if(!quoteClosers[text[index]]||(text[index]==="'"&&wordCharacter(text[index-1])))continue;
    const end=quotationEnd(text,index);
    if(end===undefined)continue;
    masked.fill(' ',index,end);index=end-1;
  }
  return masked.join('');
}

const forbid='(?:不要|别|不许|禁止|无需|不用|不必|不想|取消|停止|不(?=(?:再|重新|另行|另外|需要|想|要)?(?:生成|创建|新建|安排|规划|制定|设计|保存|写入|写|修改|改动|改写|更改|更新|编辑|重写|改|发布|发表|删除|移除|删|撤回|复制|载入|加载|导入|覆盖))|\\bdo\\s+not\\b|\\bdon\'t\\b|\\bnever\\b)';
const readOnly=/(?:只|仅)(?:需要|要|帮我)?(?:解释|分析|阅读|查看|回答|总结|翻译|咨询)|\bread[ -]only\b|\bonly\s+(?:explain|read|analy[sz]e|answer|summari[sz]e|translate)\b/i;
const memoryObject='(?:笔记|记忆|游记|\\bnotes?\\b|\\bmemor(?:y|ies)\\b)';
const planObject='(?:方案|计划|行程|一日游|多日游|\\bplans?\\b|\\bitinerar(?:y|ies)\\b)';
const postObject='(?:帖子|贴文|贴子|\\bposts?\\b)';
const editAction='(?:修改|改动|改写|更改|更新|编辑|重写|改|\\b(?:modify|edit|change|rewrite|update)\\b)';
const deleteAction='(?:删除|移除|删|撤回|\\b(?:delete|remove|withdraw)\\b)';
interface WritePolicy{object:string;action:string}
function writePolicy(tool:string):WritePolicy|undefined{
  if(tool==='memories.create')return {object:memoryObject,action:'(?:保存|创建|新建|记下|记录|写|\\b(?:create|save|write|record)\\b)'};
  if(tool==='memories.edit')return {object:memoryObject,action:editAction};
  if(tool==='memories.delete')return {object:memoryObject,action:deleteAction};
  if(tool==='plans.create')return {object:planObject,action:'(?:生成|创建|新建|安排|规划|制定|设计|保存|做|\\b(?:create|generate|save|make)\\b)'};
  if(tool==='plans.delete')return {object:planObject,action:deleteAction};
  if(tool==='plans.copy')return {object:planObject,action:'(?:复制|\\bcopy\\b)'};
  if(tool==='plans.load')return {object:planObject,action:'(?:载入|加载|导入|覆盖|\\b(?:load|import|overwrite)\\b)'};
  if(tool.startsWith('plans.')||tool==='companion.apply'||tool==='companion.rest')return {object:planObject,action:editAction};
  if(tool==='account.nickname')return {object:'(?:昵称|账号|账户|\\b(?:nickname|profile|account)\\b)',action:editAction};
  if(tool==='community.post_publish')return {object:postObject,action:'(?:发布|发表|发|创建|新建|\\b(?:create|publish|write|post)\\b)'};
  if(tool==='community.post_visibility')return {object:`(?:${postObject}|可见范围|权限|\\bvisibility\\b)`,action:editAction};
  if(tool==='community.post_withdraw')return {object:postObject,action:deleteAction};
  if(tool==='community.comment_delete')return {object:'(?:评论|回复|\\b(?:comments?|replies)\\b)',action:deleteAction};
  return undefined;
}

/** A scoped read request can coexist with an explicit operation in another clause. */
function separatelyRequestedWrite(clause:string,tool:string):boolean{
  if(new RegExp(forbid,'i').test(clause)||readOnly.test(clause)||/如何|怎么|是否|要不要|\b(?:whether|how|why)\b/i.test(clause))return false;
  if(tool==='favorites.set'||tool==='community.post_favorite')return /收藏|\b(?:favorite|bookmark)\b/i.test(clause);
  if(tool==='community.post_like')return /点赞|\blike\b/i.test(clause);
  const policy=writePolicy(tool);
  return Boolean(policy&&new RegExp(policy.object,'i').test(clause)&&new RegExp(policy.action,'i').test(clause));
}

/** A model cannot override a user's explicit read-only or domain-specific prohibition. */
export function agentWriteRestriction(request: string, tool: string): string | undefined {
  const text=agentInstructionOutsideOriginals(request);
  if(/(?:不要|别|不许|禁止|无需|不用).{0,6}(?:保存|写入|创建|修改|发布|删除|操作)(?:任何|全部|东西|内容|数据)|\b(?:do\s+not|don't|never)\s+(?:save|write|create|change|publish|delete)\s+(?:anything|any\s+(?:data|content)|everything)\b/i.test(text))return '用户明确要求只读或禁止写入，本次不能保存、发布或修改内容。';
  const clauses=text.split(/[，,；;。\n]|(?:然后|之后|接着|另外|此外|而是|但是|不过)|\b(?:then|also)\b/i);
  const reads=clauses.filter(clause=>readOnly.test(clause));
  if(reads.length){
    const policy=writePolicy(tool),knownObject=new RegExp(`${memoryObject}|${planObject}|${postObject}|昵称|账号|账户|\\b(?:nickname|profile|account)\\b`,'i');
    const readApplies=reads.some(clause=>!knownObject.test(clause)||Boolean(policy&&new RegExp(policy.object,'i').test(clause)));
    if(readApplies||!clauses.some(clause=>separatelyRequestedWrite(clause,tool)))return '用户明确要求只读或禁止写入，本次不能保存、发布或修改内容。';
  }
  const policy=writePolicy(tool);
  if(policy){
    const restricted=new RegExp(`${forbid}.{0,8}${policy.action}.{0,25}${policy.object}|${policy.object}.{0,8}${forbid}.{0,8}${policy.action}`,'i');
    if(clauses.some(clause=>restricted.test(clause)))return '用户明确禁止这项写入，请完成原请求中其他允许的操作。';
  }
  return undefined;
}
