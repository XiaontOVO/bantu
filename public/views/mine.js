/** 我的：账号身份、偏好、AI 与数据、维护。旅行参数归行程。 */
import { escapeHtml } from '../lib/format.js';
import { state } from '../lib/store.js';
import { guestRetentionNotice } from '../lib/account-retention.js';
import { agentDockVisible } from '../lib/agent-dock.js';
import { compactModeEnabled } from '../lib/compact-mode.js';
import { achievementEntry } from './achievements.js';
import { smartCompanionEnabled } from '../lib/smart-companion-preferences.js';

    export function renderMine() {
      const ready = state.ready;
      const isAccount = state.principal?.kind === 'account';
      const communityNickname = state.principal?.nickname || state.principal?.username || '';
      const nicknameControl = !isAccount ? '' : state.editingCommunityNickname
        ? `<form class="nickname-edit-form" data-nickname-form aria-label="修改社区昵称"><input id="communityNickInput" maxlength="30" required value="${escapeHtml(communityNickname)}" aria-label="社区昵称"><button class="nickname-action save" type="submit" aria-label="保存昵称" title="保存">✓</button><button class="nickname-action cancel" type="button" data-action="cancel-community-nickname-edit" aria-label="取消修改" title="取消">×</button></form>`
        : `<button class="nickname-display" type="button" data-action="edit-community-nickname" aria-label="修改社区昵称：${escapeHtml(communityNickname)}" title="点击修改昵称"><span>${escapeHtml(communityNickname)}</span><svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true"><path d="m12.8 3.2 4 4M3 17l3.6-.8L16.6 6.2a1.7 1.7 0 0 0-2.4-2.4L4.2 13.8 3 17Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`;
      return `
        <div class="page-head"><h2>我的</h2></div>

        <div class="section-head"><h3>账号</h3></div>
        <div class="profile-overview${isAccount ? ' is-account' : ''}">
        <div class="card"><div class="profile-row"><div><strong>我的账号</strong><span>${escapeHtml(state.principal?.username || '游客 · 尚未绑定账号')}</span></div><button data-action="account-panel" class="btn-primary">${state.principal?.kind === 'account' ? '账号管理' : '登录 / 注册'}</button></div>
          <div class="profile-row community-nickname-row"><div><strong>社区昵称</strong><span>${isAccount ? '发帖、评论与评价时展示；点击昵称即可修改' : '注册账号后可保存固定昵称，用于社区发帖与评价'}</span></div>${nicknameControl}</div></div>
        ${guestRetentionNotice(state.principal)}
        </div>

        ${achievementEntry()}
        <div class="profile-settings-grid">
        <section class="card profile-setting-card"><h3>通用</h3>
          <div class="profile-row"><div><strong>智能伴行</strong><span>到达地点附近，伴途主动介绍并朗读</span></div><button class="btn-small" data-action="open-smart-companion-settings">${smartCompanionEnabled(state.principal?.principalId)?'已开启':'设置'}</button></div>
          <div class="profile-row"><div><strong>伴途悬浮窗</strong><span>可拖动的小聊天窗，关闭后可在这里恢复</span></div><button class="btn-small" data-action="toggle-agent-dock-visibility" aria-pressed="${agentDockVisible()}">${agentDockVisible() ? '已开启' : '未开启'}</button></div>
          <div class="profile-row"><div><strong>参观设置</strong><span>统一设置自动进入、讲解、音乐和音色</span></div><button class="btn-small" data-action="open-scene-settings">设置</button></div>
          <div class="profile-row"><div><strong>简约模式</strong><span>图文操作按钮只显示图标</span></div><button class="btn-small" data-action="compact-toggle" aria-label="切换简约模式" aria-pressed="${compactModeEnabled()}">${compactModeEnabled() ? '已开启' : '未开启'}</button></div>
          <div class="profile-row"><div><strong>大字模式</strong><span>户外看起来更清楚</span></div><button class="btn-small" data-action="font-toggle">切换</button></div>
          <div class="profile-row"><div><strong>深浅色</strong><span>跟随你的环境光</span></div><button class="btn-small" data-action="theme-toggle">切换</button></div>
        </section>

        <section class="card profile-setting-card"><h3>AI 与数据</h3>
          <div class="profile-row"><div><strong>Agent 服务</strong><span>${ready?.agentService?.enabled ? (ready.agentService.source === 'custom' ? '自有 API · 仅对你的账号生效' : '伴途官方 · 测试期可直接使用') : '服务暂不可用 · 可选择自己的 API'}</span></div><button class="btn-primary" data-action="model-settings">选择服务</button></div>
          <div class="profile-row"><div><strong>计划与进度</strong><span>按日期保存，打开应用就能继续安排和记录</span></div><span class="chip">已启用</span></div>
        </section>

        <section class="card profile-setting-card"><h3>维护</h3>
          <div class="profile-row"><div><strong>刷新应用</strong><span>重新加载当前页面和最新数据</span></div><button class="btn-small btn-soft" data-action="refresh-app">刷新</button></div>
          <div class="profile-row"><div><strong>安装为应用</strong><span>Edge/Chrome → 应用 → 安装此站点</span></div><button class="btn-small btn-soft" data-action="install-pwa">查看</button></div>
        </section>
        </div>

        <details class="card advanced">
          <summary><strong>高级信息</strong><span class="stop-meta">给开发者看的技术参数</span></summary>
          <div class="profile-row"><div><strong>平台地点审核</strong><span>运营方使用审核凭证处理收录申请</span></div><button class="btn-small btn-soft" data-action="open-moderation">打开审核</button></div>
          ${typeof location !== 'undefined' && ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) ? '<div class="profile-row"><div><strong>官方 Agent 服务维护</strong><span>仅服务器本机可修改全站默认 API</span></div><button class="btn-small btn-soft" data-action="official-model-settings">维护</button></div>' : ''}
          <div style="margin-top:12px">
            <div class="profile-row"><div><strong>日期计划</strong><span>${isAccount ? '日程与进度独立保存到账号' : '日程与进度按当前游客身份保存'}</span></div><span class="chip">独立模式</span></div>
          </div>
          <div class="row-between" style="margin-top:14px"><strong>运行检查</strong><button class="btn-small btn-ghost" data-action="load-ready">刷新</button></div>
          ${ready ? `<div class="stop-meta" style="margin-top:6px">${Object.entries(ready.checks || {}).map(([key, value]) => `<div class="profile-row"><span>${escapeHtml(key)}</span><code class="mono">${escapeHtml(String(value))}</code></div>`).join('') || '内存原型运行正常。'}</div>` : '<p class="stop-meta" style="margin-top:6px">点击刷新查看状态存储、模型、地点、路线和限流状态。</p>'}
          <p class="stop-meta" style="margin-top:12px">当前为本地服务模式；账号、计划和记忆按当前身份保存。</p>
        </details>`;
    }
