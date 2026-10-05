import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { OpenAiCompatibleModelProvider } from '../providers/openai-compatible-model.js';
import type { ModelProvider } from '../providers/model.js';
import {parseModelControls,type ModelControls} from '../providers/model-controls.js';

export interface SavedModel extends ModelControls { enabled: boolean; baseUrl: string; modelName: string; apiKey: string }

/** 仅供本机管理的模型配置；不进入旅行快照、响应或浏览器存储。 */
export class ModelSettings {
  private saved?: SavedModel;
  provider?: ModelProvider;
  constructor(private readonly file: string, fallback?: ModelProvider, private readonly fetchImpl?: typeof fetch) {
    this.provider = fallback;
    if (existsSync(file)) {
      this.saved = JSON.parse(readFileSync(file, 'utf8')) as SavedModel;
      this.provider = this.saved.enabled ? this.build(this.saved) : undefined;
    }
  }
  view() {
    return { enabled: Boolean(this.provider), baseUrl: this.saved?.baseUrl || '',
      modelName: this.saved?.modelName || this.provider?.modelName || '', hasKey: Boolean(this.saved?.apiKey),
      ...parseModelControls(this.saved as unknown as Record<string,unknown> ?? {...this.provider?.controls}), thinkingStatus:this.provider?.thinking,
      source: this.saved ? 'local' : this.provider ? 'environment' : 'none' };
  }
  private build(config: SavedModel) {
    // Connection probes are short; real planning turns use their own bounded deadline.
    return new OpenAiCompatibleModelProvider({ ...config, fetchImpl: this.fetchImpl });
  }
  private persist(config: SavedModel) {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file + '.tmp', JSON.stringify(config), { mode: 0o600 });
    renameSync(this.file + '.tmp', this.file);
    this.saved = config;
  }
  async test(input: Record<string, unknown>, save: boolean) {
    let url: URL;
    try { url = new URL(String(input.baseUrl || '').trim()); } catch { throw new Error('请填写完整的 API 地址。'); }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash) throw new Error('地址需使用 HTTPS；本机模型可使用 HTTP。地址中不能包含密钥或查询参数。');
    const baseUrl = url.href.replace(/\/$/, '').replace(/\/(chat\/completions|responses)$/, '');
    const modelName = String(input.modelName || '').trim();
    const apiKey = String(input.apiKey || '').trim() || (baseUrl === this.saved?.baseUrl ? this.saved.apiKey : '');
    if (!modelName || modelName.length > 200 || !apiKey || apiKey.length > 4096) throw new Error('请填写模型名称和 API Key。更换 API 地址后需要重新填写密钥。');
    const config = { enabled: true, baseUrl, modelName, apiKey, ...parseModelControls(input,baseUrl===this.saved?.baseUrl&&modelName===this.saved.modelName?this.saved:{}) };
    const provider = this.build(config);
    await testModelTools(provider);
    if (save) { this.persist(config); this.provider = provider; }
    return { ...this.view(), tested: true, message: save ? '连接和工具调用测试通过，已启用。' : '连接和工具调用测试通过，尚未保存。' };
  }
  disable() {
    this.persist({ enabled: false, baseUrl: this.saved?.baseUrl || '', modelName: this.saved?.modelName || '', apiKey: '' });
    this.provider = undefined;
    return this.view();
  }
}

/** Both official and personal providers must pass a complete tool/result round trip. */
export async function testModelTools(provider: ModelProvider): Promise<void> {
    const messages = [{ role: 'user' as const, content: 'Connection test: call bantu_connection_probe with value "ok". Do not answer until you call this tool.' }];
    const tools = [{ name: 'bantu_connection_probe', description: 'Check tool calling. Call with value ok.', inputSchema: { type: 'object', properties: { value: { type: 'string', enum: ['ok'] } }, required: ['value'] } }];
    const limits={maxOutputTokens:provider.thinking?.mode==='on'?2048:128,timeoutMs:provider.thinking?.mode==='on'?30000:15000};
    const first = await provider.generateTurn({ messages, tools, ...limits });
    if (first.error) throw new Error(modelConnectionFailure(first.error.code));
    const call = first.toolCalls[0];
    if (first.toolCalls.length !== 1 || call?.name !== tools[0].name || call.arguments.value !== 'ok') throw new Error('接口可连接，但模型未完成工具调用测试。请选择支持工具调用的模型后重试。');
    const second = await provider.generateTurn({ tools, ...limits, messages: [...messages,
      { role: 'assistant', content: first.text, toolCalls: first.toolCalls, reasoningContent:first.reasoningContent,providerReplay:first.providerReplay },
      { role: 'tool', toolCallId: call.callId, toolName: call.name, content: '{"ok":true}' },
    ] });
    if (second.error) throw new Error(modelConnectionFailure(second.error.code));
    if (!second.text || second.toolCalls.length) throw new Error('模型未完成工具结果回传测试，请重试或更换模型。');
}

function modelConnectionFailure(code: string) {
    if(code==='MODEL_THINKING_UNSUPPORTED')return '此模型无法使用所选思考模式，请调整参数协议或更换模型。';
    if (/401|403/.test(code)) return '认证失败，请核对 API Key 和模型权限。';
    if (/429/.test(code)) return '服务额度不足或请求过于频繁，请检查账户额度。';
    if (/404/.test(code)) return '未找到接口或模型，请核对 API 地址及模型名称。';
    return '连接或请求失败，请核对地址、模型、网络和服务商状态。原有配置保持不变。';
}
