import { escapeHtml } from './format.js';
import { uiIcon } from './icons.js';

export function conversationTitle(conversations, id, messages) {
  const saved = conversations.find(item => item.conversationId === id);
  if (saved?.customTitle || !messages.length) return saved?.title || (id ? '新的对话' : '最初的对话');
  const first = messages.find(item => item.role === 'user')?.text || '';
  return [...first.split(/[。！？!?\n]/, 1)[0].replace(/^(?:请|帮我|麻烦你)\s*/, '').trim()].slice(0,24).join('') || saved?.title || '新的对话';
}

export function conversationTime(value) {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) return '尚未开始';
  const options = { timeZone: 'Asia/Shanghai' };
  const day = date.toLocaleDateString('zh-CN', { ...options, month: 'numeric', day: 'numeric' });
  const clock = date.toLocaleTimeString('zh-CN', { ...options, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return `${day} ${clock}`;
}

export function renderConversationBar(conversations, id, messages, disabled) {
  const title = conversationTitle(conversations, id, messages);
  return `<div class="agent-conversation-bar" aria-label="对话管理"><button type="button" class="agent-conversation-current" data-compact-keep-text data-action="open-agent-conversations" aria-label="选择对话，当前：${escapeHtml(title)}" ${disabled ? 'disabled' : ''}><span class="agent-conversation-symbol">${uiIcon('chat',{size:20})}</span><span class="agent-conversation-heading"><small>当前对话</small><strong>${escapeHtml(title)}</strong></span>${uiIcon('chevron-down',{size:18})}</button><button type="button" class="agent-conversation-new" data-action="new-agent-conversation" aria-label="开启新对话" ${disabled ? 'disabled' : ''}>${uiIcon('chat-add',{size:19})}<span>新对话</span></button></div>`;
}

export function renderConversationRows(conversations, currentId) {
  return conversations.map(item => {
    const current = item.conversationId === currentId;
    return `<div class="agent-conversation-row${current ? ' is-current' : ''}"><button type="button" class="agent-conversation-option" data-compact-keep-text data-action="switch-agent-conversation" data-conversation="${escapeHtml(item.conversationId)}" aria-pressed="${current}" aria-label="${current ? '当前对话' : '切换对话'}：${escapeHtml(item.title)}"><span class="agent-conversation-mark" aria-hidden="true">${uiIcon('chat',{size:17})}</span><span class="agent-conversation-copy"><span class="agent-conversation-title-line"><strong>${escapeHtml(item.title)}</strong>${current ? '<span class="agent-conversation-selected">当前</span>' : ''}</span><span class="agent-conversation-preview">${escapeHtml((item.preview || '还没有消息，开始聊聊这次旅程').replace(/[*#`]/g,''))}</span><span class="agent-conversation-meta"><span>${item.messageCount || 0} 条消息</span><time datetime="${escapeHtml(item.updatedAt || '')}">${escapeHtml(conversationTime(item.updatedAt))}</time></span></span></button><div class="agent-conversation-tools"><button type="button" class="agent-conversation-rename" data-action="rename-agent-conversation" data-conversation="${escapeHtml(item.conversationId)}" aria-label="重命名对话：${escapeHtml(item.title)}" title="重命名">${uiIcon('edit',{size:18})}</button><button type="button" class="agent-conversation-delete" data-action="delete-agent-conversation" data-conversation="${escapeHtml(item.conversationId)}" aria-label="删除对话：${escapeHtml(item.title)}" title="删除对话">${uiIcon('trash',{size:18})}</button></div></div>`;
  }).join('');
}
