import type { ModelMessage, ModelToolDefinition } from '../providers/model.js';

/** Reduce unrelated schemas without removing an authorized capability. */
export function agentToolDiscovery(definitions: ModelToolDefinition[], request: string, messages: ModelMessage[], eagerAll=false) {
  const tools=definitions.slice();
  const enabled = new Set(['plans.list','places.search','location.current','memories.list','favorites.list','account.profile','attachments.list','ui.navigate','scene.inspect','scene.highlight']);
  const domains = [...new Set(tools.map(tool=>tool.name.split('.')[0]))];
  const enable = (...names: string[]) => names.forEach(name=>enabled.add(name));
  if(eagerAll)tools.forEach(tool=>enabled.add(tool.name));
  const companionTools=tools.filter(tool=>tool.name.startsWith('companion.'));
  companionTools.forEach(tool=>enabled.add(tool.name));
  // Delegation previews often need actual inter-stop roads before deciding
  // whether to keep or change the schedule; the dispatcher remains read-only.
  if(companionTools.length)enable('routes.estimate','places.nearby','weather.forecast');
  if (/休息|歇|累了|暂停/.test(request)) enable('plans.rest','places.nearby');
  if (/天气|气温|下雨|降水/.test(request)) enable('weather.forecast');
  if (/路线|交通|步行|驾车|公交|出发|到达|完成|游览结束|跳过|中止/.test(request)) enable('routes.estimate','routes.from_current','plans.route','plans.route_segment','plans.set_transport','progress.record');
  if (/(?:纠正|修正|更正|撤销|撤回|改|修改).{0,30}(?:进度|到达|出发|完成)|(?:进度|到达|出发|完成)(?:记录|时间)?.{0,20}(?:错|误|改|纠正|修正|更正|撤销)/.test(request)) enable('progress.correct');
  if (/比较|对比/.test(request)) enable('plans.compare');
  if (/修改|调整|改成|改为|改到|加入|添加|追加|替换|再去|再逛|改名|重命名/.test(request)) enable('plans.edit','plans.adjust_stop','plans.replace_place','plans.set_transport');
  if (/延后|推迟|延迟|提前|延长|缩短|停留|(?:游览|参观).{0,12}(?:分钟|小时)/.test(request)) enable('plans.adjust_stop');
  const removingStop=/(?:移除|删除|删掉|去掉|取消).{0,24}(?:地点|景点|站点|节点|第.{0,3}站|一站|这.{0,2}站)/.test(request);
  if(removingStop||/移除|删掉|去掉/.test(request))enable('plans.edit');
  if (/载入|加载/.test(request)) enable('plans.load');
  if (/历史|恢复/.test(request)) enable('plans.versions','plans.restore');
  if (/方案|创建|规划|生成|制定|一日游/.test(request)) enable('plans.create','plans.copy','plans.route','plans.load');
  if (!removingStop&&/删除|撤销|撤回/.test(request)) enable('plans.delete','memories.delete');
  if (/地点|景点|附近|哪儿|哪里|介绍/.test(request)) enable('places.detail','places.nearby');
  for (const [pattern,domain] of [[/帖子|发帖|发布|评论|评价|点赞|推荐|收录|分享|分享码|私密|公开/,'community'],[/笔记|记忆|足迹|记录/,'memories'],[/收藏/,'favorites'],[/昵称|账号|用户名|登录/,'account'],[/照片|附件|图片/,'attachments']] as const) {
    if(pattern.test(request)) tools.filter(tool=>tool.name.startsWith(`${domain}.`)).forEach(tool=>enabled.add(tool.name));
  }
  // Checkpoint restoration never restores tools outside the current dispatcher
  // scope (notably limited companion delegation and creation tasks).
  for(const message of messages) {
    if(message.role==='assistant'&&Array.isArray(message.toolCalls)) for(const call of message.toolCalls as Array<{name?:string}>) if(call.name)enabled.add(call.name);
    if(message.role==='tool'&&message.toolName==='tools.discover') {
      try {const receipt=JSON.parse(message.content||'{}');if(receipt.ok&&Array.isArray(receipt.result?.tools))for(const tool of receipt.result.tools)if(typeof tool.name==='string')enabled.add(tool.name);} catch { /* malformed old receipts do not grant anything */ }
    }
  }
  const definition: ModelToolDefinition = {
    name:'tools.discover',
    description:'若当前工具列表没有完成用户委托所需功能，按领域读取其工具说明并启用完整参数定义。可用于计划、社区帖子/分享/评价、笔记、收藏、账号、定位、路线、天气、附件、页面和现场互动。只发现工具，不执行操作；后续仍需真正调用对应工具。',
    inputSchema:{type:'object',properties:{domains:{type:'array',minItems:1,maxItems:domains.length,uniqueItems:true,items:{type:'string',enum:domains}}},required:['domains'],additionalProperties:false},
  };
  return {
    definition,
    discover(args: Record<string,unknown>) {
      const selected = args.domains as string[];
      const found = tools.filter(tool=>selected.includes(tool.name.split('.')[0]));
      found.forEach(tool=>enabled.add(tool.name));
      return {tools:found.map(({name,description})=>({name,description})),notice:'这些工具已启用；下一轮可使用完整参数定义。此调用没有写入任何数据。'};
    },
    definitions() {return [...tools.filter(tool=>enabled.has(tool.name)),definition];},
  };
}
