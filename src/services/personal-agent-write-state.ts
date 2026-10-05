import type {ServerContext} from '../server/http/context.js';
import type {PersonalAgentTask} from './personal-agent-tasks.js';
import type {PlanningCreationGoal} from './personal-agent-planning-goal.js';
import {planningGoalsFromText,validateCreatedPlanShape} from './personal-agent-planning-goal.js';
import {agentInstructionOutsideOriginals} from './personal-agent-write-intent.js';
import {agentWriteKey} from './personal-agent-write-key.js';
import type {ModelToolCall} from '../providers/model.js';
import {pendingAgentAuthoredOriginals,type AgentAuthoredReceipt} from './personal-agent-authored-text.js';

interface WriteRecord {tool:string;args:Record<string,any>;value:any}
export interface AgentCreationStateIssue {tool:string;id:string;message:string}

function committedWrites(task:PersonalAgentTask):WriteRecord[]{
  const cached=Object.entries(task.writes).flatMap(([key,raw])=>{
    try{
      const [tool,args]=JSON.parse(key),receipt=raw as {ok?:boolean;result?:any};
      return receipt.ok===true&&!receipt.result?.pending&&!receipt.result?.confirmationRequired?[{tool,args,value:receipt.result}]:[];
    }catch{return [];}
  });
  const knownKeys=new Set(cached.map(record=>agentWriteKey(record.tool,record.args))),observedKeys=new Set<string>();
  const calls=new Map<string,{name:string;arguments:Record<string,unknown>}>(),ordered:WriteRecord[]=[];
  // writes is a key-indexed cache: overwriting a key does not preserve action order.
  // The server's tool messages retain every actual committed action, including confirmations.
  let start=-1;
  if(task.requestText)for(let index=task.messages.length-1;index>=0;index--)if(task.messages[index].role==='user'&&task.messages[index].content===task.requestText){start=index;break;}
  for(const message of task.messages.slice(start+1)){
    if(message.role==='assistant'&&Array.isArray(message.toolCalls))for(const call of message.toolCalls as ModelToolCall[])calls.set(call.callId,call);
    if(message.role!=='tool'||!message.toolCallId)continue;
    const call=calls.get(message.toolCallId);
    if(!call)continue;
    const key=agentWriteKey(call.name,call.arguments);
    if(!knownKeys.has(key))continue;
    try{
      const receipt=JSON.parse(message.content||'{}');
      if(receipt.ok!==true||receipt.replayed||receipt.result?.pending||receipt.result?.confirmationRequired)continue;
      observedKeys.add(key);ordered.push({tool:call.name,args:call.arguments,value:receipt.result});
    }catch{/* An unreadable message cannot prove a committed action. */}
  }
  return [...cached.filter(record=>!observedKeys.has(agentWriteKey(record.tool,record.args))),...ordered];
}

/** Historical facts still prevent a retry from creating another object. */
export function committedPlanningGoalIndices(task:PersonalAgentTask,goals:PlanningCreationGoal[]):Set<number>{
  const indices=new Set<number>(),objects=new Set<string>();
  for(const record of committedWrites(task)){
    if(record.tool!=='plans.create'||!record.value?.id||objects.has(record.value.id))continue;
    const index=Number(record.args.creationIndex??1),goal=goals.find(goal=>goal.creationIndex===index);
    if(!goal)continue;
    try{validateCreatedPlanShape(goal,record.value.days||[{stops:record.value.stops}]);}catch{continue;}
    indices.add(index);objects.add(record.value.id);
  }
  return indices;
}

function requestedTransform(task:PersonalAgentTask,kind:'note'|'plan'|'post',deletion:boolean):boolean{
  const subjects=kind==='note'?/笔记|记忆|游记|标题|正文|\b(?:note|memory|title|body)\b/i:kind==='plan'?/方案|计划|行程|天数|\b(?:plan|scheme|itinerary|days)\b/i:/帖子|贴文|可见范围|\b(?:post|visibility)\b/i;
  const actions=deletion?/删除|移除|清除|撤回|\bdelete\b|\bremove\b|\bwithdraw\b/i:/修改|编辑|改名|更正|更新|改为|改成|改到|调整|设为|设置|\bedit\b|\brename\b|\bupdate\b|\bchange\b/i;
  return agentInstructionOutsideOriginals(task.requestText||'').split(/[，,；;。\n]|然后|之后|接着/).some(clause=>actions.test(clause)&&!/^\s*(?:不要|不用|别|取消|停止|do\s+not\b|don't\b)/i.test(clause)&&(subjects.test(clause)||/刚才|新建|这篇|这个|它|\b(?:it|this)\b/i.test(clause)));
}

const planShape=(value:any)=>value?.days||[{stops:value?.stops}];
const shapeKey=(value:any)=>JSON.stringify(planShape(value).map((day:any)=>Array.isArray(day?.stops)?day.stops.length:null));

/** Completion uses current objects; an authorized later edit/delete has its own final state. */
export function agentCreationStateIssues(ctx:ServerContext,actorId:string,task:PersonalAgentTask,goals:PlanningCreationGoal[]):AgentCreationStateIssue[]{
  const records=committedWrites(task),issues:AgentCreationStateIssue[]=[];
  const notes=ctx.personalMemoriesService.list(actorId),plans=ctx.planLibrary.list(actorId);
  for(const [position,record] of records.entries()){
    const later=records.slice(position+1);
    if(record.tool==='memories.create'&&typeof record.value?.memoryId==='string'){
      const id=record.value.memoryId,current=notes.find(note=>note.memoryId===id);
      const last=later.filter(write=>['memories.edit','memories.delete'].includes(write.tool)&&write.args.memoryId===id).at(-1);
      if(last?.tool==='memories.delete'&&last.value?.deleted===true&&requestedTransform(task,'note',true)&&!current)continue;
      if(last?.tool==='memories.edit'&&requestedTransform(task,'note',false)&&current?.userText===last.value?.userText)continue;
      if(!current)issues.push({tool:record.tool,id,message:`先前保存的笔记「${record.value.title||'笔记'}」已不存在，未重新创建。`});
      else if(current.userText!==record.value.userText)issues.push({tool:record.tool,id,message:`先前保存的笔记「${record.value.title||'笔记'}」文字已变化，当前内容与原保存回执不同，未覆盖后来的修改。`});
    }
    if(record.tool==='community.post_publish'&&record.value?.completed===true&&typeof record.value.result?.id==='string'){
      const id=record.value.result.id,current=ctx.communityService.postDetail(id,actorId);
      const withdrawn=later.some(write=>write.tool==='community.post_withdraw'&&write.args.postId===id&&write.value?.completed===true&&write.value.result?.removed===true);
      if(withdrawn&&requestedTransform(task,'post',true)&&!current)continue;
      if(!current||!current.mine)issues.push({tool:record.tool,id,message:'先前发布的帖子已不存在，可能已删除或已撤回；未重新发布。'});
      else if(current.text!==record.value.result.text)issues.push({tool:record.tool,id,message:'先前发布的帖子文字已变化，未覆盖后来的修改。'});
    }
    if(record.tool==='plans.create'&&typeof record.value?.id==='string'){
      const id=record.value.id,goal=goals.find(goal=>goal.creationIndex===Number(record.args.creationIndex??1));
      if(!goal)continue;
      // An already-invalid legacy receipt does not block a valid correction.
      try{validateCreatedPlanShape(goal,planShape(record.value));}catch{continue;}
      const current=plans.find(plan=>plan.id===id);
      const last=later.filter(write=>write.tool.startsWith('plans.')&&write.tool!=='plans.create'&&(write.args.planId===id||write.value?.id===id)).at(-1);
      if(last?.tool==='plans.delete'&&last.value?.deleted===true&&requestedTransform(task,'plan',true)&&!current)continue;
      if(last&&last.tool!=='plans.delete'&&requestedTransform(task,'plan',false)&&current&&shapeKey(current)===shapeKey(last.value))continue;
      if(!current)issues.push({tool:record.tool,id,message:`先前保存的方案「${record.value.name||'方案'}」已不存在，未重新创建。`});
      else try{validateCreatedPlanShape(goal,planShape(current));}catch{issues.push({tool:record.tool,id,message:`先前保存的方案「${record.value.name||'方案'}」已变化，当前天数或每日地点数不再满足原要求，未覆盖后来的修改。`});}
    }
  }
  return issues;
}

/** Continuing the old request cannot authorize a new mutation of a conflicting object. */
export function agentConflictingWriteRestriction(ctx:ServerContext,actorId:string,task:PersonalAgentTask,tool:string,args:Record<string,unknown>):string|undefined{
  const targets=new Set([args.memoryId,args.planId,args.schemeId,args.postId].filter((id):id is string=>typeof id==='string'));
  const issues=agentCreationStateIssues(ctx,actorId,task,planningGoalsFromText(task.requestText||''));
  let issue=issues.find(issue=>targets.has(issue.id));
  if(!issue&&['memories.create','community.post_publish'].includes(tool)){
    const kind=tool==='memories.create'?'note':'post';
    const sameKindIssue=issues.find(issue=>issue.tool===tool);
    if(sameKindIssue){
      const receipts=committedWrites(task).flatMap(record=>{
        const saved=record.tool==='memories.create'?record.value:record.tool==='community.post_publish'&&record.value?.completed===true?record.value.result:null;
        const kind=record.tool==='memories.create'?'note':'post',id=kind==='note'?saved?.memoryId:saved?.id,text=kind==='note'?saved?.userText:saved?.text;
        return typeof id==='string'&&typeof text==='string'?[{kind,id,text,...(record.args.sourceIndex!==undefined?{sourceIndex:record.args.sourceIndex}:{})} as AgentAuthoredReceipt]:[];
      });
      const independentOriginal=pendingAgentAuthoredOriginals(task.requestText||'',receipts).some(original=>original.kind===kind&&(args.sourceIndex===undefined||original.sourceIndex===args.sourceIndex));
      if(!independentOriginal)issue=sameKindIssue;
    }
  }
  return issue?`${issue.message}这项旧任务不能继续修改、删除或发布已变化的对象。请先核对当前内容，再提出新的操作要求。`:undefined;
}
