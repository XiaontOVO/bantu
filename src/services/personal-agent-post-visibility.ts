import type { ModelToolDefinition } from '../providers/model.js';
import type { ServerContext } from '../server/http/context.js';
import { prepareCommunityAction, type PendingCommunityAction } from './personal-agent-community-actions.js';

/** A missing model field must never turn an explicit private request into publication. */
export function postPublishVisibility(value: unknown, requestText = ''): 'public' | 'private' {
  if (value !== undefined && value !== 'public' && value !== 'private') throw new Error('请选择公开或仅自己可见。');
  // Titles and body quotations are authored content, not visibility commands.
  // Keep a quoted enum only when it is explicitly the visibility field value.
  const quoted = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|《[^》]*》/g;
  const instructions = requestText.replace(quoted,(quote:string,offset:number)=>{
    const prefix=requestText.slice(0,offset);
    const content=quote.slice(1,-1).trim();
    const clause=prefix.split(/[，。；;\n]/).at(-1) || '';
    const rangeValue=/(?:可见范围|发布范围|visibility|权限)\s*(?:(?:设为|设置为|设成|设置成|改为|改成|为|是|[:：=])\s*)?$/i.test(prefix) || /(?:设为|设置为|设成|设置成|改为|改成|转为)\s*$/.test(clause) && !/标题|正文|内容|文字|名称|标签/.test(clause);
    return rangeValue && /^(?:public|private|公开|私密|不公开|仅自己可见)$/i.test(content) ? content : ' ';
  }).replace(/(?:标题|正文|内容)\s*(?:是|为|写成|写为|写|[:：])\s*[^，。；;\n]*/g,' ');
  const notPublic = /不公开|(?:不要|别|不能|不允许).{0,8}(?:公开|取消私密)/;
  const prohibitsPublic = notPublic.test(instructions);
  const positive = instructions.replace(new RegExp(notPublic.source,'g'),' ');
  const publicChange = /(?:改为|改成|改回|设为|设置为|设置成|转为|保持|维持)\s*(?:公开|public)|取消私密/i.test(positive);
  const privateTarget = /(?:改为|改成|改回|设为|设置为|设置成|转为|保持|维持|可见范围\s*[:：=]?|发布范围\s*[:：=]?|visibility\s*[:：=]?)\s*(?:私密|private)|仅(?:我|自己|本人)可见|只有(?:我|自己|本人)(?:能|可以)?(?:看|可见)|^(?:private|私密)[。.!！\s]*$/i.test(instructions);
  const privatePublication = /(?:私密|private)\s*(?:的\s*)?(?:帖子|post|发布|发帖)|(?:发布|发帖|发一?篇|发一?个|保存)[^，。；;：:\n]{0,12}(?:私密|\bprivate\b)|\b(?:publish|post)\b[^,.;:\n]{0,20}\bprivate\b/i.test(instructions);
  const privateRequest = prohibitsPublic || privateTarget || !publicChange && privatePublication;
  const publicRequest = publicChange || /(?:公开|public)\s*(?:的\s*)?(?:帖子|post|发布|发帖)|(?:发布|发帖)[^，。；;：:\n]{0,12}(?:公开|\bpublic\b)|(?:可见范围|发布范围|visibility)\s*[:：=]?\s*(?:公开|public)|^(?:public|公开)[。.!！\s]*$/i.test(positive);
  if (privateRequest && publicRequest) throw new Error('可见范围要求有矛盾，请明确选择公开或仅自己可见；本次没有发布。');
  if (privateRequest && value === 'public') throw new Error('用户要求私密发布，请将可见范围设为 private；本次没有发布。');
  if (publicRequest && value === 'private') throw new Error('用户要求公开发布，请将可见范围设为 public；本次没有发布。');
  return privateRequest || value === 'private' ? 'private' : 'public';
}

export function communityPostVisibilityTools(ctx: ServerContext, actorId: string, onPrepare: (pending: PendingCommunityAction) => void, requestText:()=>string=()=> ''): Array<ModelToolDefinition & {writes:true;run:(args:Record<string,unknown>)=>unknown}> {
  return [{
    name:'community.post_visibility', writes:true,
    description:'按用户明确要求修改自己帖子的可见范围。先用 community.post_detail 读取本人帖子与当前 visibility；expectedVisibility 必须匹配刚读到的范围，visibility 为 public（公开）或 private（仅自己可见）。生成包含帖子、原范围和目标范围的确认预览，等待用户确认修改，不能直接执行或修改他人的帖子。转为私密会移除其他人的收藏快照，原正文、照片和评论保留。',
    inputSchema:{type:'object',properties:{postId:{type:'string',minLength:1},expectedVisibility:{type:'string',enum:['public','private']},visibility:{type:'string',enum:['public','private']}},required:['postId','expectedVisibility','visibility'],additionalProperties:false},
    run:args=>{
      const visibility=postPublishVisibility(args.visibility,requestText());
      const pending=prepareCommunityAction(ctx,actorId,'post_visibility',{postId:String(args.postId || ''),expectedVisibility:args.expectedVisibility as 'public'|'private',visibility});
      onPrepare(pending);return {pending:true,prompt:pending.prompt};
    },
  }];
}
