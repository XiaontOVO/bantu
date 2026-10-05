import { api } from './api.js';
import { $ } from './store.js';
import { escapeHtml } from './format.js';
import { openSheet, toast } from './ui.js';
import { loadReady } from './loaders.js';
import { render } from './render.js';

let busy = false;
const modelOptionSelected = (actual, expected) => actual === expected ? 'selected' : '';
const fields = config => `
  <div class="field"><label for="modelUrl">API 地址（Base URL）</label><input id="modelUrl" type="url" placeholder="https://你的服务地址/v1" value="${escapeHtml(config.baseUrl)}" autocomplete="off" maxlength="2048"></div>
  <div class="field"><label for="modelName">模型名称</label><input id="modelName" placeholder="填写服务商提供的模型 ID" value="${escapeHtml(config.modelName)}" autocomplete="off" maxlength="200"></div>
  <div class="field"><label for="modelKey">API Key</label><input id="modelKey" type="password" placeholder="${config.hasKey ? '已保存，留空保留；换地址时需重新填写' : '粘贴你的 API Key'}" autocomplete="new-password" maxlength="4096"></div>
  <div class="field"><label for="modelApiFormat">API 格式</label><select id="modelApiFormat" data-ui="picker"><option value="chat-completions" ${modelOptionSelected(config.apiFormat,'chat-completions')}>Chat Completions</option><option value="responses" ${modelOptionSelected(config.apiFormat,'responses')}>Responses API</option></select></div>
  <div class="model-thinking-fields"><div class="field"><label for="modelCustomThinking">此接入的深度思考</label><select id="modelCustomThinking" data-ui="picker"><option value="off" ${modelOptionSelected(config.thinking,'off')}>关闭</option><option value="on" ${modelOptionSelected(config.thinking,'on')}>开启</option></select></div><div class="field"><label for="modelCustomEffort">开启后的强度</label><select id="modelCustomEffort" data-ui="picker"><option value="low" ${modelOptionSelected(config.thinkingEffort,'low')}>较轻</option><option value="high" ${modelOptionSelected(config.thinkingEffort,'high')}>深入</option></select></div></div>
  <details class="model-advanced"><summary>接口高级设置</summary><div class="field"><label for="modelThinkingFormat">思考参数协议</label><select id="modelThinkingFormat" data-ui="picker">${[['auto','自动识别'],['reasoning-effort','reasoning effort'],['thinking-type','thinking type'],['enable-thinking','enable thinking'],['reasoning-enabled','reasoning enabled'],['chat-template','本地 chat template'],['none','无思考开关']].map(([value,label])=>`<option value="${value}" ${modelOptionSelected(config.thinkingFormat,value)}>${label}</option>`).join('')}</select><p class="stop-meta">自动识别以接口地址为先。代理或本地服务无法识别时，按服务实际支持的协议选择；不支持的模式不会悄悄退回默认。</p></div></details>`;

function thinkingPanel(config) {
  const info=config.thinkingStatus, supported=Boolean(info?.supported);
  return `<section class="model-thinking-panel" aria-labelledby="modelThinkingHeading"><div><strong id="modelThinkingHeading">深度思考</strong><p id="modelThinkingNote" class="stop-meta">${escapeHtml(info?.message || '当前服务未提供可切换的思考模式。')}</p></div><div class="model-thinking-fields"><div class="field"><label for="modelThinking">本人的思考偏好</label><select id="modelThinking" data-ui="picker" ${supported?'':'disabled'}><option value="off" ${modelOptionSelected(info?.mode || 'off','off')} ${info&&!info.canDisable?'disabled':''}>关闭</option><option value="on" ${modelOptionSelected(info?.mode,'on')}>开启</option></select></div><div class="field"><label for="modelThinkingEffort">开启后的强度</label><select id="modelThinkingEffort" data-ui="picker" ${supported&&info?.effortSupported?'':'disabled'}><option value="low" ${modelOptionSelected(info?.effort,'low')}>较轻</option><option value="high" ${modelOptionSelected(info?.effort || 'high','high')}>深入</option></select></div></div><button class="btn-soft" data-action="save-thinking" ${supported?'':'disabled'}>保存思考偏好</button><p class="stop-meta">只影响本人后续请求，不改变其他用户或正在执行的任务。${info?.effortSupported?'': '此接口仅设置开关，强度由服务商决定。'}</p></section>`;
}

export async function openModelSettings(admin = false) {
  if (busy) { toast('服务设置正在处理中，请稍候'); return; }
  if (admin && !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) { toast('官方服务只能在服务器本机维护', 'error'); return; }
  const config = await api(admin ? '/api/v1/settings/model' : '/api/v1/me/model');
  const custom = admin ? config : config.custom;
  const incompatible=admin?config.thinkingStatus?.mode==='off'&&config.thinkingStatus?.supported&&!config.thinkingStatus?.canDisable:config.official.enabled&&config.mode==='official'&&!config.enabled;
  openSheet(`<div class="sheet-head"><h3>${admin ? '官方服务维护' : 'Agent 服务'}</h3><button class="icon-btn" data-action="close-sheet" aria-label="关闭">✕</button></div>
    <section class="model-settings" data-model-settings data-settings-path="${admin ? '/api/v1/settings/model' : '/api/v1/me/model'}">
    ${admin ? '<p class="stop-meta">此配置是全站默认官方服务，仅服务器本机可维护。修改后会影响使用官方服务的用户。</p>' : `
    <p class="stop-meta">让伴途理解你的需求，调用工具安排旅程。默认使用官方服务，也可以接入自己的模型。</p>
    ${thinkingPanel(config)}
    <fieldset class="model-service-choices"><legend>选择 Agent 服务</legend>
      <label class="model-service-choice"><input type="radio" name="modelServiceChoice" value="official" data-action="choose-model-service" ${config.mode === 'official' ? 'checked' : ''}><span><strong>伴途官方</strong><small>测试期提供 · 无需填写密钥</small></span><span class="chip">${incompatible?'需调整设置':config.official.enabled ? '已接入' : '暂不可用'}</span></label>
      <label class="model-service-choice"><input type="radio" name="modelServiceChoice" value="custom" data-action="choose-model-service" ${config.mode === 'custom' ? 'checked' : ''}><span><strong>自行接入</strong><small>使用自己的 API · 仅对你的账号生效</small></span></label>
    </fieldset>
    <div id="officialModelPanel" class="model-service-panel" ${config.mode === 'custom' ? 'hidden' : ''}><p>${incompatible?'当前思考偏好与官方模型不兼容，请先调整本人偏好或接入支持关闭思考的模型。':config.official.enabled ? '首页随行、Agent 对话和行程调整均可直接使用，无需填写 API。' : '官方服务暂不可用，请稍后重试或接入自己的 API。'}</p><button class="btn-primary" data-action="use-official-model" ${config.mode === 'official' || !config.canConfigure ? 'disabled' : ''}>${config.mode === 'official' ? '正在使用官方服务' : '使用官方服务'}</button></div>`}
    <div id="customModelPanel" class="model-service-panel" ${!admin && config.mode !== 'custom' ? 'hidden' : ''}>
      ${!admin && !config.canConfigure ? '<p>游客可直接使用官方服务。登录或注册后，可以保存并使用自己的 API。</p><button class="btn-primary" data-action="account-panel">登录 / 注册</button>' : `
      ${fields(custom)}
      <p class="stop-meta">支持 Chat Completions 或 Responses API，模型需具备工具调用能力。${admin ? '密钥保留在服务器，不会回显。' : '使用公网 HTTPS 地址，密钥在服务器加密保存，不会回显。'}测试包含完整工具往返；开启思考会增加时间和额度消耗。</p>
      <div class="model-settings-actions"><button class="btn-soft" data-action="test-model">测试连接</button><button class="btn-primary" data-action="save-model">测试并启用</button></div>
      <button class="btn-ghost model-remove-key" data-action="disable-model" ${custom.hasKey ? '' : 'disabled'}>${admin ? '关闭官方服务并删除密钥' : '删除自有 API 与密钥'}</button>`}
    </div>
    <p id="modelResult" class="model-settings-result" role="status">${incompatible?'当前思考偏好与模型不兼容':admin ? (config.enabled ? '官方服务已启用' : '官方服务未连接') : (config.enabled ? `当前使用${config.mode === 'custom' ? '自有 API' : '官方服务'}` : '当前选定服务暂不可用')}</p>
    </section>`);
}

export function chooseModelService(el) {
  if (busy) return;
  $('officialModelPanel').hidden = el.value !== 'official';
  $('customModelPanel').hidden = el.value !== 'custom';
}

export async function configureModel(action) {
  if (busy) return;
  const section = document.querySelector('[data-model-settings]');
  const status = $('modelResult');
  if (!section || !status) return;
  const path = section.dataset.settingsPath;
  const admin = path === '/api/v1/settings/model';
  const body = action === 'thinking' ? {thinking:$('modelThinking')?.value,thinkingEffort:$('modelThinkingEffort')?.value} : action === 'official' ? { mode: 'official' } : {
    ...(!admin ? { mode: 'custom' } : {}), baseUrl: $('modelUrl')?.value, modelName: $('modelName')?.value, apiKey: $('modelKey')?.value,
    apiFormat:$('modelApiFormat')?.value,thinking:$('modelCustomThinking')?.value,thinkingEffort:$('modelCustomEffort')?.value,thinkingFormat:$('modelThinkingFormat')?.value,
  };
  const controls = [...section.querySelectorAll('button, input, select')];
  const disabled = controls.map(el => el.disabled);
  busy = true; controls.forEach(el => { el.disabled = true; });
  status.textContent = action === 'thinking' ? '正在保存思考偏好…' : action === 'official' ? '正在切回官方服务…' : action === 'disable' ? '正在删除密钥…' : '正在验证连接与工具调用，请稍候…';
  let result;
  try {
    result = await api(`${path}${action === 'thinking' ? '/preferences' : action === 'test' ? '/test' : ''}`, {
      method: action === 'disable' ? 'DELETE' : 'POST', ...(action === 'disable' ? {} : { body: JSON.stringify(body) }),
    });
    status.textContent = result.message || '官方服务已关闭，密钥已删除。';
    if (action === 'thinking') {
      try { await loadReady(); render(); }
      catch { status.textContent += ' 页面服务状态暂未刷新，可重新打开查看。'; }
    }
    if (action !== 'test' && action !== 'thinking') {
      const key = section.querySelector('#modelKey');
      const hasKey = admin ? result.hasKey : result.custom.hasKey;
      if (key) { key.value = ''; key.placeholder = hasKey ? '已保存，留空保留；换地址时需重新填写' : '粘贴你的 API Key'; }
      try { await loadReady(); render(); }
      catch { status.textContent = `${result.message || '设置已保存。'} 页面状态暂未刷新，可稍后重新打开查看。`; }
    }
  } catch (error) { status.textContent = error.message; }
  finally {
    busy = false; controls.forEach((el, index) => { el.disabled = disabled[index]; });
    if(result?.thinkingStatus && section.isConnected) {
      const note=section.querySelector('#modelThinkingNote');if(note)note.textContent=result.thinkingStatus.message;
      const mode=section.querySelector('#modelThinking');if(mode)mode.value=result.thinkingStatus.mode;
      const effort=section.querySelector('#modelThinkingEffort');if(effort){effort.value=result.thinkingStatus.effort;effort.disabled=!result.thinkingStatus.effortSupported;}
      for(const control of section.querySelectorAll('#modelThinking, [data-action="save-thinking"]'))control.disabled=!result.thinkingStatus.supported;
      const off=section.querySelector('#modelThinking option[value="off"]');if(off)off.disabled=!result.thinkingStatus.canDisable;
    }
    if (result && action !== 'test' && action !== 'thinking' && section.isConnected) {
      const remove = section.querySelector('[data-action="disable-model"]');
      if (remove) remove.disabled = !(admin ? result.hasKey : result.custom.hasKey);
      if (!admin) {
        const official = result.mode === 'official';
        const radio = section.querySelector(`[name="modelServiceChoice"][value="${result.mode}"]`);
        if (radio) radio.checked = true;
        section.querySelector('#officialModelPanel').hidden = !official;
        section.querySelector('#customModelPanel').hidden = official;
        const use = section.querySelector('[data-action="use-official-model"]');
        use.disabled = official; use.textContent = official ? '正在使用官方服务' : '使用官方服务';
        if (action === 'disable') { section.querySelector('#modelUrl').value = ''; section.querySelector('#modelName').value = ''; }
      }
    }
  }
}
