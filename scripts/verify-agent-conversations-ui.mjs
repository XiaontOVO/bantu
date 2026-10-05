// Touch/browser verification of persistent isolated dialogues and composer drafts.
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {createHttpServer} from '../dist/src/server/http-server.js';
import {MemoryStateStore} from '../dist/src/persistence/state-store.js';
import {launchMobileBrowser,browserPause} from './lib/mobile-browser.mjs';
const server=createHttpServer({seedDemo:false,stateStore:new MemoryStateStore()});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser,checks=0;const evidence=[];
try {
 browser=await launchMobileBrowser('bantu-conversations-',{headless:process.argv.includes('--headless'),gpu:true});
 const {evaluate,tap,fill,command,until,viewport}=browser;
 const check=(value,label)=>{checks++;assert.ok(value,label)};
 const capture=async name=>{await until(()=>evaluate(`!document.getElementById('toast')?.classList.contains('show')`),'toast settles for screenshot');await browserPause(300);evidence.push({name,path:await browser.screenshot(name)})};
 const url=`http://127.0.0.1:${server.address().port}/#/agent`;
 await command('Page.navigate',{url});await until(()=>evaluate('window.__bantuBooted===true'),'boot');
 await evaluate(`(async()=>{window.s=(await import('/lib/store.js')).state;window.paint=(await import('/lib/render.js')).render;window.nav=(await import('/lib/render.js')).navigate;window.api=(await import('/lib/api.js')).api;(await import('/lib/agent-dock.js')).dismissAgentDock();await api('/api/v1/agent/chat',{method:'POST',body:JSON.stringify({text:'旧对话的旅行记录',clientMessageId:'old-ui'})});await (await import('/lib/loaders.js')).loadGeneralMessages();paint()})()`);
 for(const width of [320,390,430]){
  await viewport(width,844);await browserPause(180);
  check(await evaluate(`document.documentElement.scrollWidth<=innerWidth+1`),'no page overflow '+width);
  check(await evaluate(`!document.querySelector('[data-action=confirm-delete-chat-message],.chat-message-delete')`),'no delete control '+width);
  check(await evaluate(`(()=>{const a=document.querySelector('.agent-conversation-current').getBoundingClientRect(),b=document.querySelector('[data-action=new-agent-conversation]').getBoundingClientRect();return Math.abs(a.y-b.y)<1&&Math.abs(a.height-b.height)<1&&a.height>=43.9})()`),'aligned controls '+width);
 }
 await viewport(390,844);await fill('#chatText','旧对话未发送草稿');
 await tap('[data-action=new-agent-conversation]');await until(()=>evaluate(`s.agentConversationId&&!s.agentConversationLoading`),'new conversation');
 const id=await evaluate('s.agentConversationId');
 check(await evaluate(`s.messages.length===0&&document.getElementById('chatText').value===''`),'new dialogue does not inherit history or draft');
 await fill('#chatText','新对话独立草稿');await capture('new-dialogue-390');
 await tap('[data-action=open-agent-conversations]');await until(()=>evaluate(`!!document.querySelector('.agent-conversation-panel')`),'list');await capture('dialogue-list-390');
 await tap(`[data-action=rename-agent-conversation][data-conversation="${id}"]`);await until(()=>evaluate(`!!document.getElementById('agentConversationTitle')`),'rename editor');
 await fill('#agentConversationTitle','上海半日散步');await tap('[data-action=save-agent-conversation-title]');await until(()=>evaluate(`!!document.querySelector('.agent-conversation-panel')&&document.querySelector('.agent-conversation-list').textContent.includes('上海半日散步')`),'renamed list');
 check(await evaluate(`document.querySelector('.agent-conversation-option[aria-pressed=true]').textContent.includes('当前')&&!document.querySelector('.agent-conversation-number')&&document.querySelectorAll('.agent-conversation-mark svg').length===2`),'current label without misleading numbering');
 for(const mode of [{width:320,dark:true,large:true,compact:true},{width:390,dark:false,large:false,compact:true},{width:430,dark:false,large:false,compact:true}]){
  await viewport(mode.width,844);await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(mode.dark?'dark':'light')};document.body.classList.toggle('large-text',${mode.large})`);await browserPause(150);
  await evaluate(`import('/lib/compact-mode.js').then(m=>m.setCompactMode(${mode.compact}))`);
  check(await evaluate(`[...document.querySelectorAll('.agent-conversation-heading strong,.agent-conversation-title-line strong,.agent-conversation-preview,.agent-conversation-meta,.agent-conversation-selected')].every(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0})`),'compact mode retains all conversation information '+mode.width);
  check(await evaluate(`(()=>{const a=document.querySelector('.agent-conversation-current').getBoundingClientRect(),b=document.querySelector('.agent-conversation-bar [data-action=new-agent-conversation]').getBoundingClientRect();return a.width>100&&Math.abs(a.height-b.height)<1&&a.height>=55.9})()`),'compact conversation controls stay aligned '+mode.width);
  check(await evaluate(`document.documentElement.scrollWidth<=innerWidth+1&&[...document.querySelectorAll('.agent-conversation-tools button')].every(e=>{const r=e.getBoundingClientRect();return r.width>=43.9&&r.height>=43.9})`),'list fit and management targets '+mode.width);await capture('dialogue-list-'+mode.width+(mode.dark?'-dark-large':''));
 }
 await viewport(390,844);await evaluate(`document.documentElement.dataset.theme='light';document.body.classList.remove('large-text');import('/lib/compact-mode.js').then(m=>m.setCompactMode(false))`);
 await tap('[data-action=switch-agent-conversation][data-conversation=""]');await until(()=>evaluate(`s.agentConversationId===''&&!s.agentConversationLoading`),'old dialogue');
 check(await evaluate(`s.messages[0]?.text==='旧对话的旅行记录'&&document.getElementById('chatText').value==='旧对话未发送草稿'`),'old dialogue history and draft survive switching');
 await tap('[data-action=open-agent-conversations]');await until(()=>evaluate(`!!document.querySelector('.agent-conversation-panel')`),'list again');await tap(`[data-action=switch-agent-conversation][data-conversation="${id}"]`);await until(()=>evaluate(`s.agentConversationId===${JSON.stringify(id)}&&!s.agentConversationLoading`),'new dialogue restored');
 check(await evaluate(`document.getElementById('chatText').value==='新对话独立草稿'`),'new draft survives switching');
 await evaluate(`api('/api/v1/agent/chat',{method:'POST',body:JSON.stringify({text:'新对话旅行记录',conversationId:s.agentConversationId,clientMessageId:'new-ui'})})`);
 await command('Page.reload',{ignoreCache:true});await until(()=>evaluate(`window.__bantuBooted===true&&document.querySelector('#chatText')?.dataset.chatConversation===${JSON.stringify(id)}`),'reload selected conversation');
 check(await evaluate(`document.querySelector('.agent-conversation-heading strong').textContent==='上海半日散步'&&document.querySelector('.chat-list').textContent.includes('新对话旅行记录')&&!document.querySelector('.chat-list').textContent.includes('旧对话的旅行记录')`),'reload preserves selected history only');
 await evaluate(`(async()=>{window.s=(await import('/lib/store.js')).state;window.nav=(await import('/lib/render.js')).navigate;nav('home');(await import('/lib/agent-dock.js')).openAgentDock()})()`);await browserPause(400);
 check(await evaluate(`!document.querySelector('.agent-dock-panel [data-action=open-agent-conversations],.agent-dock-panel [data-action=new-agent-conversation],.agent-dock-panel .agent-conversation-bar')&&!document.querySelector('[data-action=confirm-delete-chat-message]')`),'floating chat has no conversation management or delete');
 check(await evaluate(`document.querySelector('.agent-dock-panel .chat-list').getBoundingClientRect().height>=160`),'floating chat uses recovered header space');
 await capture('floating-dialogue-390');check(browser.exceptions.length===0,browser.exceptions.join('\n'));
 await evaluate(`(async()=>{(await import('/lib/agent-dock.js')).closeAgentDock();nav('agent')})()`);
 await tap('[data-action=open-agent-conversations]');await until(()=>evaluate(`!!document.querySelector('.agent-conversation-panel')`),'delete list');
 await tap(`[data-action=delete-agent-conversation][data-conversation="${id}"]`);
 check(await evaluate(`document.querySelector('.agent-conversation-editor').textContent.includes('上海半日散步')&&document.querySelector('.agent-conversation-editor').textContent.includes('计划、帖子、笔记和收藏会保留')`),'delete preview identifies exact conversation and scope');
 await tap('.agent-conversation-editor [data-action=open-agent-conversations]');await until(()=>evaluate(`!!document.querySelector('.agent-conversation-panel')`),'cancel deletion');
 check(await evaluate(`s.agentConversations.some(c=>c.conversationId===${JSON.stringify(id)})`),'cancel leaves conversation intact');
 await tap(`[data-action=delete-agent-conversation][data-conversation="${id}"]`);await tap('[data-action=confirm-delete-agent-conversation]');await until(()=>evaluate(`s.agentConversationId===''&&!s.agentConversationLoading`),'delete selected conversation');
 check(await evaluate(`s.messages[0]?.text==='旧对话的旅行记录'&&!s.agentConversations.some(c=>c.conversationId===${JSON.stringify(id)})`),'deleting selected conversation returns to retained history');
 await command('Page.reload',{ignoreCache:true});await until(()=>evaluate(`window.__bantuBooted===true&&document.querySelector('.chat-list')?.textContent.includes('旧对话的旅行记录')`),'reload after delete');
 check(await evaluate(`!document.querySelector('.chat-list').textContent.includes('新对话旅行记录')`),'deleted conversation stays deleted after reload');
 await evaluate(`import('/lib/store.js').then(m=>window.s=m.state)`);
 await tap('[data-action=open-agent-conversations]');await until(()=>evaluate(`!!document.querySelector('.agent-conversation-panel')`));await tap('[data-action=delete-agent-conversation][data-conversation=""]');await tap('[data-action=confirm-delete-agent-conversation]');await until(()=>evaluate(`s.agentConversationId!==''&&!s.agentConversationLoading`));
 const replacement=await evaluate('s.agentConversationId');
 check(await evaluate(`s.messages.length===0&&s.agentConversations.length===1&&!s.agentConversations.some(c=>c.conversationId==='')`),'deleting last legacy conversation creates an empty usable replacement');
 await command('Page.reload',{ignoreCache:true});await until(()=>evaluate(`window.__bantuBooted===true&&document.querySelector('#chatText')?.dataset.chatConversation===${JSON.stringify(replacement)}`));
 check(await evaluate(`!document.querySelector('.chat-list').textContent.includes('旧对话的旅行记录')`),'default history does not reappear after deletion');
 writeFileSync('tmp/agent-conversations-ui-proof.json',JSON.stringify({checks,evidence,output:browser.output,isolatedData:true},null,2));console.log(JSON.stringify({checks,output:browser.output}));
}catch(error){if(browser)console.log(JSON.stringify({shot:await browser.screenshot('failure'),errors:browser.exceptions}));throw error}
finally{browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
