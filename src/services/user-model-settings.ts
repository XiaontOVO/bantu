import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ModelProvider } from '../providers/model.js';
import { OpenAiCompatibleModelProvider } from '../providers/openai-compatible-model.js';
import { publicModelFetch, publicModelUrl } from '../providers/public-model-fetch.js';
import { testModelTools, type SavedModel } from './model-settings.js';
import { parseModelControls, type ThinkingMode, type ThinkingEffort } from '../providers/model-controls.js';

type UserModel = { mode: 'official' | 'custom'; custom?: SavedModel;thinking?: ThinkingMode;thinkingEffort?: ThinkingEffort };
const online = (provider?: ModelProvider) => Boolean(provider && provider.providerName !== 'scripted');

/** Separate encrypted vault; secrets never enter user snapshots, chat or browser storage. */
export class UserModelSettings {
  private entries = new Map<string, UserModel>();
  private providers = new Map<string, ModelProvider>();
  private revisions = new Map<string, number>();
  private testing = new Set<string>();
  constructor(private readonly file?: string, private readonly fetchImpl: typeof fetch = publicModelFetch) {
    if (file && existsSync(file)) {
      const envelope = JSON.parse(readFileSync(file, 'utf8'));
      const key = this.key(false);
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
      this.entries = new Map(JSON.parse(plaintext.toString('utf8')));
    }
  }
  private key(create: boolean): Buffer {
    const path = this.file + '.key';
    if (!existsSync(path) && create) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, randomBytes(32), { mode: 0o600, flag: 'wx' });
    }
    const key = readFileSync(path);
    if (key.length !== 32) throw new Error('用户模型密钥库不可用，请联系服务维护者。');
    return key;
  }
  private commit(actorId: string, entry?: UserModel): void {
    const next = new Map(this.entries);
    if (entry) next.set(actorId, entry); else next.delete(actorId);
    if (this.file) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key(true), iv);
      const data = Buffer.concat([cipher.update(JSON.stringify([...next]), 'utf8'), cipher.final()]);
      const envelope = { version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
      writeFileSync(this.file + '.tmp', JSON.stringify(envelope), { mode: 0o600 });
      renameSync(this.file + '.tmp', this.file);
    }
    this.entries = next;
    this.providers.delete(actorId);
    this.revisions.set(actorId, (this.revisions.get(actorId) || 0) + 1);
  }
  providerFor(actorId: string | undefined, official?: ModelProvider): ModelProvider | undefined {
    const entry = actorId ? this.entries.get(actorId) : undefined;
    if (!actorId || entry?.mode !== 'custom') return entry?.thinking&&official?.withThinking?official.withThinking(entry.thinking,entry.thinkingEffort):official;
    if (!entry.custom) return undefined;
    let provider = this.providers.get(actorId);
    if (!provider) {
      provider = new OpenAiCompatibleModelProvider({ ...entry.custom,...(entry.thinking?{thinking:entry.thinking,thinkingEffort:entry.thinkingEffort}:{}), fetchImpl: this.fetchImpl });
      this.providers.set(actorId, provider);
    }
    return provider;
  }
  view(actorId: string | undefined, official?: ModelProvider) {
    const entry = actorId ? this.entries.get(actorId) : undefined;
    const current=this.providerFor(actorId,official),thinking=current?.thinking;
    const compatible=!thinking || thinking.mode!=='off' || !thinking.supported || thinking.canDisable;
    return {
      mode: entry?.mode || 'official', enabled: online(current)&&compatible,
      official: { enabled: online(official), label: '伴途官方服务 · 测试期' },
      thinkingStatus:thinking,
      custom: { baseUrl: entry?.custom?.baseUrl || '', modelName: entry?.custom?.modelName || '', hasKey: Boolean(entry?.custom?.apiKey), ...parseModelControls({...entry?.custom,...(entry?.thinking?{thinking:entry.thinking,thinkingEffort:entry.thinkingEffort}:{})}) },
    };
  }
  useOfficial(actorId: string): void {
    this.commit(actorId, { ...this.entries.get(actorId), mode: 'official' });
  }
  remove(actorId: string): void { const previous=this.entries.get(actorId);this.commit(actorId,{mode:'official',thinking:previous?.thinking,thinkingEffort:previous?.thinkingEffort}); }
  setThinking(actorId: string,input: Record<string,unknown>,official?:ModelProvider):void {
    const provider=this.providerFor(actorId,official),controls=parseModelControls(input);
    if(!provider?.withThinking)throw new Error('当前服务未提供思考开关，请配置支持切换的模型接口。');
    const next=provider.withThinking(controls.thinking!,controls.thinkingEffort);
    if(!next.thinking?.supported || controls.thinking==='off'&&!next.thinking.canDisable)throw new Error(next.thinking?.message || '当前模型不支持切换思考模式。');
    this.commit(actorId,{...this.entries.get(actorId),mode:this.entries.get(actorId)?.mode ?? 'official',thinking:controls.thinking,thinkingEffort:controls.thinkingEffort});
  }
  async test(actorId: string, input: Record<string, unknown>, save: boolean): Promise<void> {
    if (this.testing.has(actorId)) throw new Error('连接测试正在进行，请稍候再试。');
    const revision = this.revisions.get(actorId) || 0;
    const url = publicModelUrl(input.baseUrl);
    const baseUrl = url.href.replace(/\/$/, '').replace(/\/(chat\/completions|responses)$/, '');
    const previous = this.entries.get(actorId)?.custom;
    const modelName = String(input.modelName || '').trim();
    const apiKey = String(input.apiKey || '').trim() || (previous?.baseUrl === baseUrl ? previous.apiKey : '');
    if (!modelName || modelName.length > 200 || !apiKey || apiKey.length > 4096 || /[\r\n]/.test(apiKey)) throw new Error('请填写模型名称和 API Key。更换地址后需要重新填写密钥。');
    const config = { enabled: true, baseUrl, modelName, apiKey, ...parseModelControls(input,previous?.baseUrl===baseUrl&&previous.modelName===modelName?previous:{}) };
    const provider = new OpenAiCompatibleModelProvider({ ...config, fetchImpl: this.fetchImpl });
    this.testing.add(actorId);
    try {
      await testModelTools(provider);
      if ((this.revisions.get(actorId) || 0) !== revision) throw new Error('服务选择已发生变化，本次测试未覆盖新设置，请重新打开设置。');
      if (save) { this.commit(actorId, { mode: 'custom', custom: config,thinking:config.thinking,thinkingEffort:config.thinkingEffort }); this.providers.set(actorId, provider); }
    } finally { this.testing.delete(actorId); }
  }
}
