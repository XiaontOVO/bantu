const normalizedText = (text: string) => text.replace(/\r\n|\r/g, '\n').trim();

export type AgentAuthoringKind = 'note' | 'post';
export interface AgentAuthoredOriginal {
  /** One sequence across notes and posts, in the user's request order. */
  sourceIndex: number;
  kind?: AgentAuthoringKind;
  text: string;
}
/** Only actual committed object receipts belong here, never a preview or a model claim. */
export interface AgentAuthoredReceipt {
  kind: AgentAuthoringKind;
  text: string;
  sourceIndex?: number;
  id: string;
}

interface Quotation { start: number; end: number; text: string }
interface AuthoringIntent { start: number; end: number; kind?: AgentAuthoringKind; writable: boolean; bound: boolean }
const kindOf = (word: string): AgentAuthoringKind => /帖子|^posts?$/i.test(word) ? 'post' : 'note';
const closers: Record<string, string> = { '“': '”', '‘': '’', '「': '」', '『': '』' };

function quotationAt(text: string, start: number): Quotation | undefined {
  const opener = text[start], closer = closers[opener] || opener;
  let depth = 1;
  for (let index = start + 1; index < text.length; index++) {
    if ((opener === '"' || opener === "'") && text[index] === '\\') { index++; continue; }
    // Apostrophes within words do not close an ASCII single-quoted original.
    if (opener === "'" && text[index] === "'" && /[\p{L}\p{N}]/u.test(text[index - 1] || '') && /[\p{L}\p{N}]/u.test(text[index + 1] || '')) continue;
    if (opener !== closer && text[index] === opener) depth++;
    if (text[index] !== closer || --depth > 0) continue;
    return { start, end: index + 1, text: normalizedText(text.slice(start + 1, index)) };
  }
  return undefined;
}

/** Quoted content cannot itself authorize a write or change its object kind. */
function maskQuotations(text: string): string {
  // Use string offsets rather than code-point offsets, because RegExp.index uses UTF-16.
  const masked = text.split('');
  for (let index = 0; index < text.length; index++) {
    if (!/[“‘「『"']/.test(text[index])) continue;
    if (text[index] === "'" && /[\p{L}\p{N}]/u.test(text[index - 1] || '')) continue;
    const quotation = quotationAt(text, index);
    if (!quotation) continue;
    for (let cursor = index; cursor < quotation.end; cursor++) masked[cursor] = ' ';
    index = quotation.end - 1;
  }
  return masked.join('');
}

function authoringIntents(masked: string): AuthoringIntent[] {
  const intents: AuthoringIntent[] = [];
  const object = '(笔记|记忆|游记|帖子|\\bnotes?\\b|\\bmemories\\b|\\bmemory\\b|\\bposts?\\b)';
  const write = '(?:保存|新建|创建|新增|写下|写好|写|记录|记下|发布|发表|发(?=[^，。；;:：\\n]{0,12}帖子)|\\bcreate\\b|\\bsave\\b|\\bwrite\\b|\\brecord\\b|\\bpublish\\b)';
  const read = '(?:阅读|查看|解释|分析|评价|总结|翻译|参考|读一下|读|\\bread\\b|\\bexplain\\b|\\banaly[sz]e\\b|\\breview\\b|\\bsummari[sz]e\\b|\\btranslate\\b)';
  const negative = /(?:不要|不能|无需|不必|禁止|别|暂不|不打算|不想|不需要|并非要|不是要|不|\bdo\s+not\b|\bdon't\b|\bnever\b)\s*(?:再|继续|自动|直接)?\s*$/i;
  // Overlapping matches select the last explicit action for an object (e.g. "阅读后保存笔记").
  const forward = new RegExp(`(?=(${write}|${read})([^，。；;:：\\n]{0,32}?)${object})`, 'gi');
  for (const match of masked.matchAll(forward)) {
    const start = match.index!, action = match[1];
    const preceding = masked.slice(Math.max(0, start - 18), start);
    const end = start + action.length + match[2].length + match[3].length;
    const existing = intents.findIndex(intent => intent.end === end);
    if (existing >= 0) intents.splice(existing,1);
    const questionScope = new RegExp(`${read}[^，。；;:：\\n]{0,12}(?:如何|怎么|怎样|为什么|\\bhow\\b|\\bwhy\\b)[^，。；;:：\\n]{0,12}$`, 'i').test(preceding);
    const passive = questionScope || /(?:已|已经|曾|刚刚|刚)\s*$/.test(preceding) || /^(?:的|过|了|完毕)/.test(match[2]);
    const ambiguous = new RegExp(`^\\s*(?:和|与|及|或|或者|、|\\band\\b|\\bor\\b)\\s*(?:一(?:篇|条))?${object}`, 'i').test(masked.slice(end));
    intents.push({start, end, ...(!ambiguous ? {kind:kindOf(match[3])} : {}), writable: new RegExp(`^${write}$`, 'i').test(action) && !negative.test(preceding) && !passive, bound: false});
  }
  // Also accept the ordinary reverse form "把这篇笔记保存" / "save" after a named object.
  const reverse = new RegExp(`${object}([^，。；;:：\\n]{0,12}?)(${write}|${read})`, 'gi');
  for (const match of masked.matchAll(reverse)) {
    const start = match.index!, end = start + match[0].length;
    if (intents.some(intent => intent.start <= start && intent.end >= start)) continue;
    const action = match[3], actionStart = end - action.length;
    const preceding = masked.slice(Math.max(0, actionStart - 18), actionStart);
    const passive = /(?:已|已经|曾|刚刚|刚)\s*$/.test(preceding) || /^(?:了|好了|过|完毕)/.test(masked.slice(end));
    intents.push({start, end, kind: kindOf(match[1]), writable: new RegExp(`^${write}$`, 'i').test(action) && !negative.test(preceding) && !passive, bound: false});
  }
  // "记下来" explicitly delegates a personal note even without repeating the noun.
  for (const match of masked.matchAll(/记录下来|记下来|记住/gi)) {
    const start = match.index!;
    if (!intents.some(intent => intent.start <= start && intent.end > start)) intents.push({start, end:start + match[0].length, kind:'note', writable:!negative.test(masked.slice(Math.max(0,start - 18),start)), bound:false});
  }
  // A write with no object type is unresolved; it must not silently become a post or note.
  const writeText = new RegExp(`${write}[^，。；;:：\\n]{0,12}(?:原文|文字|内容|\\btext\\b|\\bwording\\b)`, 'gi');
  for (const match of masked.matchAll(writeText)) {
    const start = match.index!;
    if (!intents.some(intent => intent.start <= start && intent.end > start)) intents.push({start, end:start + match[0].length, writable:!negative.test(masked.slice(Math.max(0,start - 18),start)), bound:false});
  }
  // A later instruction to read/explain the text ends an earlier authoring scope.
  const readText = new RegExp(`${read}[^，。；;:：\\n]{0,12}(?:原文|文字|内容|\\btext\\b|\\bwording\\b)`, 'gi');
  for (const match of masked.matchAll(readText)) {
    const start = match.index!;
    if (!intents.some(intent => intent.start <= start && intent.end > start)) intents.push({start, end: start + match[0].length, writable:false, bound:false});
  }
  return intents.sort((a,b) => a.start - b.start);
}

function authoringRequest(requestText: string): { originals: AgentAuthoredOriginal[]; freeKinds: Set<AgentAuthoringKind> } {
  const masked = maskQuotations(requestText), intents = authoringIntents(masked);
  const originals: AgentAuthoredOriginal[] = [];
  const prefixes = requestText.matchAll(/(?:内容就是|原文是|原文如下|内容如下|exact\s+(?:text|wording)(?:\s+(?:is|as\s+follows))?|original\s+text(?:\s+is)?)\s*[:：]?\s*([“‘「『"'])/gi);
  let previousEnd = 0;
  for (const match of prefixes) {
    if (match.index! < previousEnd) continue;
    const preceding = masked.slice(Math.max(0, match.index! - 36), match.index!);
    if (/(?:正文|标题|摘要|描述)(?:的)?\s*[:：]?\s*$|(?:body|title|summary|description)\s*[:：]?\s*$/i.test(preceding)) continue;
    const quotation = quotationAt(requestText, match.index! + match[0].length - 1);
    if (!quotation) continue;
    previousEnd = quotation.end;
    let intent = intents.filter(item => item.start < match.index!).at(-1);
    // A postfixed instruction such as "原文是‘…’，请保存为笔记" is also explicit.
    if (!intent) intent = intents.find(item => item.start >= quotation.end && item.start - quotation.end <= 32 && !/[。.!?；;\n]/.test(masked.slice(quotation.end,item.start)));
    if (!intent?.writable || !quotation.text) continue;
    intent.bound = true;
    originals.push({sourceIndex: originals.length + 1, ...(intent.kind ? {kind:intent.kind} : {}), text:quotation.text});
  }
  return {originals, freeKinds: new Set(intents.filter(intent => intent.writable && !intent.bound && intent.kind).map(intent => intent.kind!))};
}

/** Only explicit requests to create/save/publish a whole note or post are required writes. */
export function agentAuthoredOriginals(requestText: string): AgentAuthoredOriginal[] {
  return authoringRequest(requestText).originals;
}

function originalAssignments(originals: AgentAuthoredOriginal[], receipts: AgentAuthoredReceipt[]): Set<number> {
  const assigned = new Set<number>(), actualObjects = new Set<string>();
  // Assign indexed successes first: an older unindexed receipt cannot take their place.
  for (const receipt of [...receipts].sort((a,b) => Number(b.sourceIndex !== undefined) - Number(a.sourceIndex !== undefined))) {
    if (typeof receipt.id !== 'string' || !receipt.id.trim() || typeof receipt.text !== 'string') continue;
    const object = `${receipt.kind}:${receipt.id}`;
    if (actualObjects.has(object)) continue;
    actualObjects.add(object);
    const candidates = originals.filter(original => original.kind === receipt.kind && original.text === normalizedText(receipt.text)
      && (receipt.sourceIndex === undefined || receipt.sourceIndex === original.sourceIndex));
    const original = candidates.find(candidate => !assigned.has(candidate.sourceIndex));
    if (original) assigned.add(original.sourceIndex);
  }
  return assigned;
}

/** Explicit note/post payloads still missing a distinct successful write. */
export function pendingAgentAuthoredOriginals(requestText: string, receipts: AgentAuthoredReceipt[]): AgentAuthoredOriginal[] {
  const originals = agentAuthoredOriginals(requestText), assigned = originalAssignments(originals, receipts);
  return originals.filter(original => !assigned.has(original.sourceIndex));
}

/** Explicit titles compose with their bodies; a valid title may stand alone. */
export function agentAuthoredText(args: Record<string, unknown>, label: string, requestText = '', receipts: AgentAuthoredReceipt[] = []): string {
  if (args.text !== undefined && typeof args.text !== 'string') throw new Error(`请提供有效的${label}文字。`);
  const body = typeof args.text === 'string' ? normalizedText(args.text) : '';
  let composed: string;
  if (args.title === undefined) {
    if (!body) throw new Error(`请提供${label}内容。`);
    composed = body;
  } else {
    if (typeof args.title !== 'string' || !args.title.trim() || /[\r\n]/.test(args.title)) throw new Error(`${label}标题必须是非空的单行文字。`);
    composed = [args.title.trim(), body].filter(Boolean).join('\n');
  }
  const kind: AgentAuthoringKind = label === '帖子' ? 'post' : 'note';
  const {originals:allOriginals,freeKinds} = authoringRequest(requestText), originals = allOriginals.filter(original => original.kind === kind);
  if (args.sourceIndex !== undefined && (!Number.isSafeInteger(args.sourceIndex) || Number(args.sourceIndex) < 1)) throw new Error(`${label}原文序号必须是正整数。`);
  if (allOriginals.some(original => !original.kind && (args.sourceIndex === undefined || original.sourceIndex === args.sourceIndex))) throw new Error('原文信息缺失：请明确这篇原文要保存为笔记，还是发布为帖子。');
  // A separate free-writing request may coexist with one or more literal payloads.
  const freeWrite = args.sourceIndex === undefined && freeKinds.has(kind) && !originals.some(original => original.text === composed);
  if (allOriginals.length && !originals.length && !freeWrite) throw new Error(`用户提供的原文没有授权创建${label}。请按原文所属的帖子或笔记类型处理，不要互换。`);
  if (!freeWrite && originals.length > 1 && args.sourceIndex === undefined) throw new Error(`这条指令包含多篇${label}原文，请用 sourceIndex 指定对应原文序号：${originals.map(original => original.sourceIndex).join('、')}。不要用同一篇替代其他原文。`);
  const original = freeWrite ? undefined : args.sourceIndex === undefined ? originals[0] : originals.find(item => item.sourceIndex === args.sourceIndex);
  if (args.sourceIndex !== undefined && allOriginals.length && !original) {
    throw new Error(`${label}的 sourceIndex ${args.sourceIndex} 不属于本类原文。当前${label}可用的原文序号：${originals.map(item => item.sourceIndex).join('、')}。请只修正 sourceIndex，保持用户提供的标题和正文；不要为序号问题改写文字。${originals.length === 1 ? '本类只有一篇原文，也可省略 sourceIndex。' : ''}`);
  }
  if (original && original.text !== composed) {
    throw new Error(`${label}文字与用户明确提供的原文不一致。请按原文重新提交，不要添加、重复标题或改写文字；仅有一行标题时可只传title，text可省略或为空。`);
  }
  if (original && originalAssignments(allOriginals,receipts).has(original.sourceIndex)) throw new Error(`原文 ${original.sourceIndex} 的${label}已经保存或发布。请继续处理其他未完成的原文，不要重复创建。`);
  return composed;
}

export const AGENT_AUTHORING_INSTRUCTIONS = '帖子与笔记的第一行是标题，后续各行是正文。用户提供多行原文时，保留第一行标题与其余正文，不得遗漏标题、把标题改成正文或擅自改写原文。调用 community.post_publish 或 memories.create 时优先用 title 单独传标题，text 只传正文（不要重复标题）；仅有标题时 text 可省略或为空，不能虚构正文。兼容旧格式：未传 title 时，text 必须完整包含第一行标题和后续正文。用户明确要求创建、保存或发布原文，并用“内容就是”“原文是”或 exact text 提供引号内完整原文时，必须保存该原文，不能追加标题、重复该行或改写。只阅读、解释、分析原文或单独指定正文、标题不意味着要求创建整篇对象。多篇待创建原文按指令出现顺序从1编号；同类多篇必须传 sourceIndex，编号在帖子和笔记之间连续，帖子与笔记不可互换原文。每一篇都需要独立成功回执，预览不算发布，不能只保存第一篇就宣称全部完成；相同文字的两篇明确请求可使用不同sourceIndex分别保存。已完成序号不得重复创建。原文确实含有重复的标题与正文时仍须保留。工具拒绝不一致的文字后，应重新核对原文再修正参数。用户只要求修改标题时不改正文。草拟内容可按用户委托撰写，但不得编造其真实游览经历；发布帖子仍须工具预览并等待确认。';
