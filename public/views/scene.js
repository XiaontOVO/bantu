import { escapeHtml } from '../lib/format.js';
import { state } from '../lib/store.js';
import { uiIcon } from '../lib/icons.js';
import { buttonContent } from '../lib/button-content.js';
import { sceneHitRegion } from '../lib/scene-hit-regions.js';
import { sceneSoundPlaying, sceneSoundStarting } from '../lib/scene-sound.js';
import { scenePreferences } from '../lib/scene-preferences.js';
import { sceneArtworkState, sceneArtworkSource } from '../lib/scene-artwork.js';

export function renderScene() {
  const scene = state.sceneData;
  if (!scene || scene.placeId !== state.scenePlaceId) {
    return '<section class="card scene-loading" role="status"><h2>正在准备地点现场…</h2><p>先从已经核实的地点资料开始。</p><button class="btn-soft" data-action="leave-place-scene">返回</button></section>';
  }
  const selected = scene.hotspots.find(item => item.id === state.sceneSelectedHotspotId);
  const artwork = sceneArtworkState(scene);
  const selectedRegion = selected && sceneHitRegion(scene.id,selected);
  const bubbleLeft = selectedRegion && selectedRegion.left + selectedRegion.width / 2 > 60;
  const soundStarting = sceneSoundStarting();
  const sound = sceneSoundPlaying() || soundStarting;
  const prefs = scenePreferences(state.principal?.principalId);
  const exploreHint = prefs.quiet ? '轻触画中的元素，展开文字介绍' :
    !prefs.music ? '轻触画中的元素，展开介绍 · 音乐已关闭' :
    !prefs.narration ? '轻触画中的元素，展开文字与音乐' : '轻触画中的元素，听故事与音乐';
  const explored = scene.hotspots.filter(item => state.sceneVisited.includes(item.id));
  return `<section class="place-scene scene-immersive${state.sceneQuiet ? ' is-quiet' : ''}" data-artwork-status="${artwork.status}" data-artwork-text="${artwork.textMode}" data-theme-scene="${escapeHtml(scene.soundTheme)}" aria-label="${escapeHtml(scene.placeName)}地点现场">
    <header class="scene-header">
      <button class="scene-back" data-action="leave-place-scene" aria-label="离开地点现场">${uiIcon('arrow-left', { size: 18 })}<span>返回</span></button>
      <div class="scene-title"><h2>${escapeHtml(scene.placeName)}</h2></div>
      <button class="scene-immersive-toggle" data-action="enter-scene-immersive" aria-label="${state.sceneFullscreenActive ? '退出全屏' : '横屏全屏探索'}">${uiIcon('expand',{size:19})}<span>横屏探索</span></button>
      <button class="scene-sound${sound ? ' is-on' : ''}${soundStarting ? ' is-starting' : ''}" data-action="toggle-scene-sound" aria-label="${soundStarting ? '取消音乐启动' : `${sound ? '关闭' : '开启'}场景音乐`}" aria-pressed="${sound}" aria-busy="${soundStarting}">${uiIcon(soundStarting ? 'refresh' : sound ? 'volume' : 'volume-off', { size: 19 })}<span>${soundStarting ? '启动中' : sound ? '音乐开' : '音乐关'}</span></button>
      <button class="scene-settings-button" data-action="open-scene-settings" aria-label="参观设置">${uiIcon('display', { size:19 })}<span>设置</span></button>
    </header>
    <div class="scene-canvas-shell">
      <div class="scene-stage" tabindex="-1" role="group" aria-label="${escapeHtml(scene.placeName)}场景画面" aria-busy="${artwork.status === 'loading'}">
        <img class="scene-artwork" ${artwork.status === 'error' ? '' : `src="${escapeHtml(sceneArtworkSource(scene))}"`} alt="${escapeHtml(scene.placeName)}的 AI 艺术场景，不是实景或平面地图" fetchpriority="high">
        <section class="scene-artwork-fallback" data-scene-artwork-state ${artwork.status === 'ready' && !artwork.textMode ? 'hidden' : ''}>
          <span class="scene-artwork-symbol" aria-hidden="true">${uiIcon('scene',{size:28})}</span>
          <div class="scene-artwork-copy" role="status"><h3 data-scene-artwork-heading>正在铺开画面…</h3><p data-scene-artwork-message>画面准备期间，也可以先听听这个地点的故事。</p></div>
          <div class="scene-artwork-recovery"><button type="button" class="btn-primary" data-action="retry-scene-artwork">${uiIcon('refresh',{size:18})}<span>重新加载</span></button><button type="button" class="btn-soft" data-action="show-scene-text">文字探索</button><button type="button" class="btn-soft" data-action="hide-scene-text" hidden>回到画面</button></div>
          <div class="scene-text-topics" data-scene-text-topics ${artwork.status === 'error' || artwork.textMode ? '' : 'hidden'}><h4>从一个主题开始</h4><div>${scene.hotspots.map(item => `<button type="button" class="scene-text-topic" data-action="explore-scene-text-topic" data-element="${escapeHtml(item.id)}" aria-pressed="${selected?.id === item.id}"><span>${escapeHtml(item.title)}${item.floor ? ` · ${escapeHtml(item.floor)}资料` : ''}</span>${uiIcon('arrow-right',{size:18})}</button>`).join('')}</div></div>
        </section>
        <div class="scene-atmosphere" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
        ${scene.hotspots.map(item => {
          const region = sceneHitRegion(scene.id, item);
          if (!region) return '';
          return `<button type="button" class="scene-hotspot${selected?.id === item.id ? ' is-active' : ''}" ${artwork.status !== 'ready' || artwork.textMode ? 'disabled' : ''} style="left:${region.left}%;top:${region.top}%;width:${region.width}%;height:${region.height}%;clip-path:polygon(${region.polygon})" data-action="select-scene-hotspot" data-hotspot="${escapeHtml(item.id)}" aria-label="探索${escapeHtml(item.title)}" aria-pressed="${selected?.id === item.id}" title="${escapeHtml(item.title)}"><span class="visually-hidden">${escapeHtml(item.title)}</span></button>`;
        }).join('')}
      </div>
      ${selected && state.sceneStoryOpen !== false ? `<div class="scene-story-anchor"><article class="scene-floating-story scene-story ${bubbleLeft ? 'is-left' : 'is-right'}" aria-live="polite"><div class="scene-bubble-head"><div class="scene-story-heading" data-scene-story-drag tabindex="0" role="button" aria-label="拖动讲解窗口，也可使用方向键"><span class="scene-story-grip" aria-hidden="true"></span><span class="scene-kicker">${selected.floor ? `${escapeHtml(selected.floor)} · 资料主题` : '伴途 · 此刻看见'}</span><h3 tabindex="-1" data-scene-story-title>${escapeHtml(selected.title)}</h3></div><button type="button" class="scene-story-close" data-action="dismiss-scene-story" aria-label="收起讲解文字">${uiIcon('close',{size:18})}</button></div><p class="scene-summary">${escapeHtml(selected.story || selected.summary)}</p><div class="scene-story-actions"><button type="button" class="scene-story-action" data-action="speak-scene-story" aria-label="重听这段介绍" title="重听">${buttonContent('volume', '重听')}</button><button type="button" class="scene-story-action" data-action="ask-scene-agent" data-hotspot="${escapeHtml(selected.id)}" aria-label="问伴途" title="问伴途">${buttonContent('agent', '问伴途')}</button><button type="button" class="scene-story-action" data-action="open-scene-map" data-floor="${escapeHtml(selected.floor || '')}" aria-label="${escapeHtml(selected.mapLabel || '查看场地总览')}" title="查看地图">${buttonContent('map', '总览')}</button><button type="button" class="scene-story-action" data-action="note-scene-hotspot" data-hotspot="${escapeHtml(selected.id)}" aria-label="记下此刻" title="记下此刻">${buttonContent('note', '记下')}</button><button type="button" class="scene-story-action" data-action="open-scene-details" aria-label="查看详细资料" title="详细资料">${buttonContent('info', '资料')}</button></div></article></div>` : ''}
      ${!selected || state.sceneStoryOpen === false ? `<div class="scene-explore-hint"><span>${uiIcon('compass',{size:18})} ${exploreHint}</span></div>` : ''}
    </div>
    <div class="scene-exploration-bar"><button type="button" class="btn-soft scene-rotate-hint" data-action="enter-scene-immersive">${uiIcon('expand',{size:18})}<span>横过手机，展开探索</span></button><button type="button" class="btn-ghost" data-action="open-scene-details">${uiIcon('info',{size:17})}<span>探索与资料</span></button><button type="button" class="btn-ghost" data-action="open-scene-map">${uiIcon('map',{size:17})}<span>场地总览</span></button>${explored.length ? `<div class="scene-explored"><span>已探索 ${explored.length} / ${scene.hotspots.length}</span><button type="button" class="btn-soft" data-action="ask-scene-recap-agent">整理为私人记忆</button></div>` : ''}</div>
    <div class="scene-cues">
      ${state.sceneTimingCue && !state.sceneQuiet ? `<div class="scene-timing-cue" role="status"><div><strong>伴途提醒 · 按原计划</strong><p>${escapeHtml(state.sceneTimingCue.text)}</p></div><div class="scene-timing-actions"><button class="btn-soft" data-action="ask-scene-timing-agent">请伴途帮我</button><button class="btn-ghost" data-action="dismiss-scene-timing">稍后再说</button></div></div>` : ''}
      ${state.sceneDepartureCue && !state.sceneQuiet ? `<div class="scene-timing-cue scene-departure-cue" role="status"><div><strong>伴途提醒 · 可能离开附近</strong><p>${escapeHtml(state.sceneDepartureCue.text)}</p></div><div class="scene-timing-actions"><button class="btn-soft" data-action="ask-scene-departure-agent">核对下一站</button><button class="btn-ghost" data-action="dismiss-scene-departure">稍后再说</button></div></div>` : ''}
    </div>
  </section>`;
}
