import { renderConversationBar } from '../lib/agent-conversation-view.js';
/** 伴途 Agent：对话列表与输入区。 */
import { escapeHtml, monthDay } from '../lib/format.js';
import { state, usesSavedDayPlans } from '../lib/store.js';
import { renderPlan } from './plan.js';
import { renderMessageMarkdown } from '../lib/message-markdown.js';
import { uiIcon } from '../lib/icons.js';
import { renderAgentCompanionAdjustment } from '../lib/companion-advice.js';
import { chatComposerDraft, chatComposerNotice } from '../lib/chat-composer.js';
import { renderAgentSpeechControl } from '../lib/agent-speech.js';

    export function renderAgent({ compact = false } = {}) {
      // 伴途不绑定具体行程也能直接对话；有旅行时开场白带上行程日期。
      const standalone = usesSavedDayPlans();
      const fixedCommands = state.ready?.checks?.agentMode === 'rules' || (!state.ready?.checks?.agentMode && state.ready?.checks?.modelProvider === 'scripted_demo');
      const conversationTripId = standalone ? '' : (state.trip?.trip?.tripId || '');
      const photoCount = (state.chatImages || []).length;
      const serviceNotice=state.ready?.agentService?.enabled===false&&state.ready?.agentService?.message;
      const draft = chatComposerDraft();
      const historyError = state.agentConversationError || '';
      const task = state.agentTaskProgress?.pending === state.chatMessagePending && state.chatMessagePending ? state.agentTaskProgress : state.agentRemoteTask;
      const completedSteps = Math.max(0, Number(task?.completedSteps) || 0);
      const taskStatus = task?.cancelRequested ? '已请求停止，等待当前步骤结束…' : task?.status && task.status !== 'running' ? '操作已处理，正在接收回复…' : completedSteps ? `已处理 ${completedSteps} 个步骤，继续执行…` : state.chatCompanionPending ? '正在核对道路与后续安排…' : '正在处理…';
      const photoLabel = state.chatImagesBusy ? '正在处理照片' : photoCount ? `更换照片，已选择 ${photoCount} 张` : '添加照片，最多 4 张';
      const messages = state.messages.length
        ? state.messages
        : historyError ? [] : [{ role: 'assistant', text: !standalone && state.trip
          ? `这趟旅行定在 ${monthDay(state.trip.trip.localDate)}。想调整安排或加个地点，直接告诉我。`
          : fixedCommands ? '当前只能处理固定指令。启用语言模型后，才能理解复杂需求并连续执行多个操作。' : '想去哪儿、怎么走，直接告诉我。我会查询地点、生成计划，执行后告诉你结果。日计划可在「计划与进度」中查看。' }];
      const quickStart = !state.messages.length && !historyError ? `<div class="agent-quick-start" aria-label="常用指令"><span>可以直接说：</span>${(compact ? ['介绍眼前的地点','帮我调整接下来的安排'] : [
        '安排徐汇一日游',
        '周末想去武康大楼和龙华寺',
        '生成两天方案：第一天去武康大楼，第二天去龙华寺',
        '看看今天有什么行程',
        '查看今天路线',
        '把今天计划保存为方案',
        '分享我的方案',
      ]).map(text => `<button type="button" class="agent-quick-chip${text.length > 18 ? ' is-wide' : ''}" data-action="use-agent-suggestion" data-text="${escapeHtml(text)}">${escapeHtml(text)}</button>`).join('')}</div>` : '';
      return `<section class="chat-shell">
        ${compact ? '' : renderConversationBar(state.agentConversations || [], state.agentConversationId || '', state.messages, state.chatPending || state.chatImagesBusy || state.agentConversationLoading)}
        ${serviceNotice ? `<div class="agent-service-notice" role="status"><p>${escapeHtml(compact ? '当前模型不支持关闭思考。请先调整服务设置。' : serviceNotice)}</p><button type="button" class="btn-soft" data-action="model-settings">${uiIcon('display',{size:18})}<span>服务设置</span></button></div>` : ''}
        <div class="chat-list" id="chatList" role="log" aria-label="与伴途的对话">
          ${state.agentConversationLoading ? '<p class="stop-meta" role="status">正在打开对话…</p>' : ''}
          ${historyError ? `<div class="bubble assistant" role="alert"><p>${escapeHtml(historyError)}</p><button type="button" class="btn-soft" data-action="switch-agent-conversation" data-conversation="${escapeHtml(state.agentConversationId || '')}">重新读取聊天记录</button></div>` : ''}
          ${state.messagesCursor ? `<div class="chat-history-actions"><button class="btn-ghost" data-action="load-older-messages" ${state.messagesLoadingOlder ? 'disabled aria-busy="true"' : ''}>${state.messagesLoadingOlder ? '正在加载…' : '加载更早消息'}</button></div>` : ''}
          ${fixedCommands ? '<p class="stop-meta" role="status">语言模型未启用 · 当前为固定指令模式</p>' : ''}
          ${messages.map((message) => {
            const isUser = message.role === 'user';
            const modeLabel = !isUser && message.agentMode === 'rules' ? '<div class="stop-meta">固定指令处理</div>' : '';
            const links = !isUser && message.resultLinks?.length ? `<div class="agent-result-links">${message.resultLinks.filter(link => ['home','today', 'plan', 'places', 'favorites', 'memories', 'community'].includes(link.view)).map(link => `<button type="button" class="btn-soft" data-agent-result-view="${escapeHtml(link.view)}" data-date="${escapeHtml(link.date || '')}" data-post-id="${escapeHtml(link.postId || '')}" data-result-id="${escapeHtml(link.planId || link.memoryId || '')}">${escapeHtml(link.label)} →</button>`).join('')}</div>` : '';
            const bubble = `<div class="bubble ${isUser ? 'user' : 'assistant message-markdown'}">${isUser ? escapeHtml(message.text) : renderMessageMarkdown(message.text)}${isUser && message.images?.length ? `<div class="post-image-draft-grid">${message.images.map(image => `<figure class="post-image-draft"><img src="${escapeHtml(image.dataUrl)}" alt="${escapeHtml(image.alt)}"></figure>`).join('')}</div>` : ''}</div>`;
            return `<div class="chat-message-row ${isUser ? 'user' : 'assistant'}">${isUser ? bubble : `<div class="agent-result-message">${modeLabel}<div class="agent-message-line">${bubble}</div>${renderAgentSpeechControl(message)}${links}${renderAgentCompanionAdjustment(message)}</div>`}</div>`;
          }).join('')}
          ${state.chatRetry && (state.chatRetry.tripId || null) === (conversationTripId || null) ? `<div class="bubble assistant chat-retry" role="alert"><p>这条消息没有收到确认${state.chatRetry.error ? `：${escapeHtml(state.chatRetry.error)}` : '。'}可以安全重试。</p><button class="btn-soft" data-action="retry-chat">重试上一条</button></div>` : ''}
          ${state.chatPending ? `<div class="bubble assistant" role="status" data-agent-task-progress data-compact-keep-text><p>${escapeHtml(taskStatus)}</p><button type="button" class="btn-ghost" data-stop-agent ${state.chatStopPending || task?.cancelRequested || (task?.status && task.status !== 'running') ? 'disabled' : ''}>${state.chatStopPending || task?.cancelRequested ? '正在停止' : '停止后续操作'}</button></div>` : ''}
          ${!state.chatPending && state.agentInterruptedTask ? `<div class="bubble assistant" role="status">上次任务中断了，已完成的操作会保留。<button type="button" class="btn-soft" data-resume-agent="${escapeHtml(state.agentInterruptedTask.id)}">继续处理</button></div>` : ''}
          ${!state.chatPending && state.agentViewSync?.refresh?.length ? '<div class="bubble assistant" role="status">操作已保存，正在重试更新页面。</div>' : ''}
          ${state.proposal ? `<section class="chat-proposal" aria-label="待确认的行程方案">${renderPlan(true)}</section>` : ''}
          ${quickStart}
          ${draft.prompt ? `<details class="chat-prompt-choice"><summary>有一段问题待填入</summary><p>${escapeHtml(draft.prompt)}</p><div><button type="button" class="btn-soft" data-action="append-agent-prompt">追加到输入</button><button type="button" class="btn-ghost" data-action="dismiss-agent-prompt">不用这段</button></div></details>` : ''}
        </div>
        <div class="chat-composer">
          <form class="chat-form" data-chat-form>
            <button class="action-icon action-icon-create agent-photo-button${photoCount ? ' has-photos' : ''}" type="button" data-select-agent-images data-photo-count="${photoCount}" title="${photoLabel}" aria-label="${photoLabel}" aria-controls="agentImageInput" ${state.chatPending || state.chatImagesBusy ? 'disabled' : ''} ${state.chatImagesBusy ? 'aria-busy="true"' : ''}>${uiIcon('photo-add', { size: 22 })}</button>
            <input id="agentImageInput" class="post-file-input" type="file" accept="image/jpeg,image/png,image/webp" multiple tabindex="-1" ${state.chatPending || state.chatImagesBusy ? 'disabled' : ''} />
            <textarea id="chatText" rows="1" data-chat-conversation="${escapeHtml(state.agentConversationId || '')}" data-chat-owner="${escapeHtml(state.principal?.principalId || '')}" placeholder="${photoCount ? '补充说明（可选）' : compact ? '问问伴途…' : '说说你的想法…'}" aria-label="输入消息" autocomplete="off" enterkeyhint="enter">${escapeHtml(draft.text)}</textarea>
            <button class="action-icon action-icon-primary" type="submit" title="发送消息" aria-label="${state.chatPending ? '正在处理消息' : state.chatImagesBusy ? '正在处理照片' : '发送消息'}" ${state.chatPending || state.chatImagesBusy || state.agentConversationLoading ? 'disabled aria-busy="true"' : ''}>${uiIcon('send', { size: 21 })}</button>
            <p class="chat-draft-status" data-chat-draft-status role="status" ${draft.text ? '' : 'hidden'}>${chatComposerNotice()}</p>
          </form>
          ${(state.chatImages || []).length ? `<div class="post-image-draft-grid" aria-label="本次发送的照片">${state.chatImages.map((image, index) => `<figure class="post-image-draft"><img src="${escapeHtml(image.dataUrl)}" alt="${escapeHtml(image.alt)}"><figcaption>${index + 1}. ${escapeHtml(image.alt)}</figcaption></figure>`).join('')}</div><button type="button" class="btn-ghost" data-clear-agent-images ${state.chatPending ? 'disabled' : ''}>清空照片</button>` : ''}
        </div>
      </section>`;
    }
