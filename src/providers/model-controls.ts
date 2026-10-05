export type ThinkingMode = 'off' | 'on';
export type ThinkingEffort = 'low' | 'high';
export type ThinkingFormat = 'auto' | 'reasoning-effort' | 'thinking-type' | 'enable-thinking' | 'reasoning-enabled' | 'chat-template' | 'none';
export type ModelApiFormat = 'chat-completions' | 'responses';
export interface ModelControls { thinking?: ThinkingMode; thinkingEffort?: ThinkingEffort; thinkingFormat?: ThinkingFormat; apiFormat?: ModelApiFormat }
export interface ModelThinkingView { mode: ThinkingMode; effort: ThinkingEffort; format: ThinkingFormat; supported: boolean; effortSupported: boolean; canDisable: boolean; verified: boolean; message: string; effortParameter?: 'reasoning_effort' }

export function parseModelControls(input: Record<string, unknown>, previous: ModelControls = {}): ModelControls {
  const values = {thinking:input.thinking ?? previous.thinking ?? 'off',thinkingEffort:input.thinkingEffort ?? previous.thinkingEffort ?? 'high',thinkingFormat:input.thinkingFormat ?? previous.thinkingFormat ?? 'auto',apiFormat:input.apiFormat ?? previous.apiFormat ?? 'chat-completions'};
  if (typeof values.thinking !== 'string' || !['off','on'].includes(values.thinking)
    || typeof values.thinkingEffort !== 'string' || !['low','high'].includes(values.thinkingEffort)
    || typeof values.thinkingFormat !== 'string' || !['auto','reasoning-effort','thinking-type','enable-thinking','reasoning-enabled','chat-template','none'].includes(values.thinkingFormat)
    || typeof values.apiFormat !== 'string' || !['chat-completions','responses'].includes(values.apiFormat)) throw new Error('模型接口或思考设置无效，请重新选择。');
  return values as Required<ModelControls>;
}

export function modelThinkingView(options: ModelControls & {baseUrl:string;modelName:string}): ModelThinkingView {
  const mode=options.thinking ?? 'off',effort=options.thinkingEffort ?? 'high';
  const name=options.modelName.toLowerCase().split('/').at(-1) ?? '';
  let host='';try {host=new URL(options.baseUrl).hostname} catch { /* URL validation belongs to settings. */ }
  let format=options.thinkingFormat ?? 'auto';
  if(format==='auto') {
    // Endpoint semantics take precedence over model names on hosted gateways.
    if(host==='openrouter.ai')format='reasoning-enabled';
    else if(/(^|\.)dashscope\.(aliyuncs|alibabacloud)\.com$/.test(host)||host==='api.qwencloud.com')format='enable-thinking';
    else if(host==='api.deepseek.com'||host==='open.bigmodel.cn'||host==='api.z.ai'||/^deepseek-/.test(name))format='thinking-type';
    else if(/^gpt-[56](?:\.|-)/.test(name)||/^o[1-9](?:-|$)/.test(name))format='reasoning-effort';
    else if(/^(gpt-4|gpt-3\.5)/.test(name))format='none';
  }
  // Native GLM 5.3 requires reasoning; its intensity is a separate top-level
  // parameter. Do not assume custom gateways share native endpoint semantics.
  const nativeGlm53=['open.bigmodel.cn','api.z.ai'].includes(host)&&format==='thinking-type'&&/^glm-5\.3(?:-(?:flash|flashx))?$/.test(name);
  const mandatory=nativeGlm53||/^o[1-9](?:-|$)/.test(name)||/^gpt-5(?:-|$)/.test(name)||/^gpt-5(?:\.\d+)?-pro(?:-|$)/.test(name);
  const supported=format!=='auto'&&format!=='none';
  const verified=format!=='auto';
  const message=nativeGlm53&&mode==='off' ? '该模型不支持关闭思考，当前偏好无法应用。可自行选择开启及较轻强度，或更换支持关闭的模型。'
    : mandatory&&format==='reasoning-effort'&&mode==='off' ? '该模型不能完全关闭思考，请更换支持非思考模式的模型。'
    : !verified ? '未识别思考协议；不能保证关闭，请在高级设置选择接口实际支持的协议。'
    : !supported ? '此接入声明为无思考开关；开启前请更换模型或参数协议。'
    : nativeGlm53?`该模型始终使用思考；已请求${effort==='low'?'较轻':'深入'}强度，每一轮工具请求沿用此设置。`
    : mode==='on'?'已请求开启深度思考；每一轮工具请求沿用此设置。':'已请求关闭深度思考；每一轮工具请求沿用此设置。';
  return {mode,effort,format,supported,effortSupported:nativeGlm53||['reasoning-effort','reasoning-enabled'].includes(format),canDisable:supported&&!mandatory,verified,message,...(nativeGlm53?{effortParameter:'reasoning_effort' as const}:{})};
}

export function thinkingParameters(view: ModelThinkingView, apiFormat: ModelApiFormat): Record<string,unknown> {
  if(view.mode==='on'&&!view.supported)throw new Error(view.message);
  if(view.mode==='off'&&(view.format==='reasoning-effort'||view.effortParameter==='reasoning_effort')&&!view.canDisable)throw new Error(view.message);
  const on=view.mode==='on';
  switch(view.format) {
    case 'thinking-type':return {thinking:{type:on?'enabled':'disabled'},...(on&&view.effortParameter==='reasoning_effort'?{reasoning_effort:view.effort}:{})};
    case 'enable-thinking':return {enable_thinking:on};
    case 'reasoning-enabled':return {reasoning:on?{enabled:true,effort:view.effort}:{enabled:false}};
    case 'chat-template':return {chat_template_kwargs:{enable_thinking:on}};
    case 'reasoning-effort':return apiFormat==='responses'?{reasoning:{effort:on?view.effort:'none'}}:{reasoning_effort:on?view.effort:'none'};
    default:return {};
  }
}
