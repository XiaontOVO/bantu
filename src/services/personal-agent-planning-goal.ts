import {agentInstructionOutsideOriginals} from './personal-agent-write-intent.js';

export interface PlanningGoal {
  days?: number;
  stopsPerDay?: number;
}
export interface PlanningCreationGoal extends PlanningGoal { creationIndex: number }

const numerals: Record<string, number> = {
  一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};
const count = (value: string): number => /^\d+$/.test(value) ? Number(value) : numerals[value] || 0;

/** Extract only explicit creation constraints; leave place choice and scheduling to the model and tools. */
export function planningGoalFromText(text: string): PlanningGoal | null {
  const goal=planningGoalsFromText(text)[0];
  if(!goal)return null;
  const {creationIndex: _index,...shape}=goal;
  return shape;
}

/** Each explicit creation has its own constraints and requires its own saved object. */
export function planningGoalsFromText(text: string): PlanningCreationGoal[] {
  text=agentInstructionOutsideOriginals(text);
  // An edit/delete/favorite in a separate requested action must not cancel
  // creation. Keep its constraints separate from references to old schemes.
  const groups=text.split(/[；;。\n]|(?:然后|之后|接着|另外|此外|而是)|(?:后|并且|并|再|同时)(?=(?:把|将|加入|追加|添加|调整|修改|替换|改成|改到|改为|恢复|对比|比较|编辑|收藏|删除|取消|生成|创建|安排|保存|记录|记笔记))/);
  const entries=groups.flatMap((group,groupIndex)=>group.split(/[，,、]/).map(clause=>({text:clause.trim(),groupIndex})).filter(clause=>clause.text));
  const clauses=entries.map(entry=>entry.text);
  const edits=/(?:取消|删除|撤回).{0,12}(?:计划|方案|行程)|(?:加入|追加|添加|调整|修改|替换|改成|改到|改为|恢复|对比|比较|编辑)/;
  // Bare “不创建/不再新建” is also a prohibition, not a new creation goal.
  // Keep it tied to the action so “时间不足，创建方案” still permits creation.
  const negated=/(?:不要|不用|无需|不能|别|不必|不想|取消|停止|不(?=(?:再|重新|另行|另外|需要|想|要)?(?:安排|规划|生成|创建|新建|制定|设计|保存|做))).{0,8}(?:安排|规划|生成|创建|新建|制定|设计|保存|做)/;
  const creating=/(?:安排|规划|生成|创建|制定|设计|保存|做)(?:(?!笔记|记忆|游记|帖子|原文|正文|标题|内容).){0,45}?(?:计划|方案|行程|一日游|多日游|旅行(?!记忆|笔记|游记|足迹|成就|照片|帖子))|(?:一日游|多日游|旅行方案)(?:(?!笔记|记忆|游记|帖子|原文|正文|标题|内容).){0,12}(?:安排|规划|生成|创建|保存)/;
  const datedVisit=/(?:安排|规划|制定|设计|生成|做)(?:(?!笔记|记忆|游记|帖子|休息|歇|暂停).){0,20}(?:今天|明天|后天|\d{4}[-年/]\d{1,2}[-月/]\d{1,2})(?:(?!笔记|记忆|游记|帖子|原文|正文|标题|内容|休息|歇|暂停).){0,30}(?:去|游览|参观|逛|散步|景点|大楼|公园|博物馆|书院|美术馆|图书馆|寺)/;
  const sourceOnly=/(?:分析|解释|阅读|读一下|看看|总结|翻译|点评).{0,25}(?:文字|内容|原文|句子|指令|请求|例子|表达)/;
  const rawIndices=clauses.flatMap((clause,index)=>!edits.test(clause)&&!negated.test(clause)&&!sourceOnly.test(clause)&&(creating.test(clause)||datedVisit.test(clause))?[index]:[]);
  // “安排北京一日游，生成方案” describes one creation and its save step.
  // A second named/count-qualified creation remains an independent target.
  const indices=rawIndices.filter((index,position)=>position===0||!/^(?:请|帮我)?(?:生成|创建|保存|安排|规划|制定|设计)(?:为)?(?:计划|方案|行程)$/.test(clauses[index]));
  return indices.map((index,goalIndex)=>{
  const nextIndex=indices[goalIndex+1];
  const qualifiers=clauses.filter((clause,qualifierIndex)=>{
    // Leading constraints belong to the creation in their own sentence/action.
    // Trailing constraints may follow a separate favorite, but never spill into
    // the leading modifiers of the next explicitly separated creation.
    const leading=qualifierIndex<index&&entries[qualifierIndex].groupIndex===entries[index].groupIndex&&(goalIndex===0||qualifierIndex>indices[goalIndex-1]);
    const trailing=qualifierIndex>index&&(nextIndex===undefined||qualifierIndex<nextIndex)&&!(nextIndex!==undefined&&entries[qualifierIndex].groupIndex===entries[nextIndex].groupIndex&&entries[index].groupIndex!==entries[nextIndex].groupIndex);
    return (leading||trailing)&&!edits.test(clause)&&!negated.test(clause)&&!creating.test(clause)&&!datedVisit.test(clause)&&/^(?:每(?:一)?天|(?:共|一共|总共|为期|总计)?\s*(?:\d{1,2}|[一二两三四五六七八九十])\s*天)/.test(clause);
  });
  text=[clauses[index],...qualifiers].join('，');
  const number = '(\\d{1,2}|[一二两三四五六七八九十])';
  const daysMatch = text.match(new RegExp(`${number}\\s*(?:天|日)(?:的)?(?:旅行|旅游|游|行程|计划|方案|安排)`))
    || text.match(new RegExp(`${number}\\s*天`));
  const stopsMatch = text.match(new RegExp(`每(?:一)?天(?:安排|去|游览|参观|逛)?\\s*${number}\\s*个?(?:地点|景点|地方|站)`));
  const days = daysMatch ? count(daysMatch[1]) : /一日游|半日游/.test(text) ? 1 : 0;
  const stopsPerDay = stopsMatch ? count(stopsMatch[1]) : 0;
  return { creationIndex:goalIndex+1,...(days > 0 && days <= 30 ? { days } : {}), ...(stopsPerDay > 0 && stopsPerDay <= 40 ? { stopsPerDay } : {}) };
  });
}

export function validateCreatedPlanShape(goal: PlanningGoal | null, days: Array<{ stops?: unknown[] }>): void {
  if (!goal) return;
  if (goal.days && days.length !== goal.days) throw new Error(`用户要求 ${goal.days} 天，请提交完整的 ${goal.days} 天安排；不能少天或拆成测试方案。`);
  if (goal.stopsPerDay && days.some(day => !Array.isArray(day.stops) || day.stops.length !== goal.stopsPerDay)) {
    throw new Error(`用户要求每天 ${goal.stopsPerDay} 个地点；请补齐每一天后再保存，允许重复到访。`);
  }
}
