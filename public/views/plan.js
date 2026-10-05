/** 方案候选：我的方案库、手动规划器与伴途候选的统一页面。 */
import { candidateMetrics, emptyState } from '../lib/components.js';
import { APPLICABILITY_LABEL, STATUS_LABEL, dateKeyInTimeZone, escapeHtml, fmt, fmtWithDay, monthDay } from '../lib/format.js';
import { itineraryTimeLabel } from '../lib/itinerary-timing.js';
import { state, usesSavedDayPlans } from '../lib/store.js';
import { render } from '../lib/render.js';
import { renderMessageMarkdown } from '../lib/message-markdown.js';
import { hasLoadError } from '../lib/load-state.js';
import { uiIcon } from '../lib/icons.js';
import { buttonContent } from '../lib/button-content.js';
import { schemeCardHeading } from '../lib/scheme-card-heading.js';
import { planRouteSummary, transportModeToStop } from '../lib/plan-route-timing.js';
import { transportPickerHtml } from '../lib/transport-picker.js';
import { selectedComparisonSchemes, comparisonButtonLabel } from '../lib/plan-comparison.js';
import { planDraftStatus, planDraftNeedsNewScheme } from '../lib/plan-draft-storage.js';
import { schemeDayContinuations } from '../lib/scheme-days.js';
import { dailyFirstStopMinutes } from '../lib/plan-start-default.js';

    export function renderPlan(inChat = false) {
      // 方案库与手动规划不需要旅行；伴途候选基于旅行生成，无旅行时仅展示提示。
      if (inChat) return renderCandidates(true);
      return `
        <div class="page-head"><h2>方案候选</h2></div>
        ${renderCandidates(false)}
        ${renderPlanLibrary()}`;
    }

    function renderCandidates(inChat) {
      // 候选区只在实际有可对比的方案时出现；空态占位没有信息量，进伴途对话走侧栏统一入口。
      if (!state.proposal) {
        return inChat ? '<p class="stop-meta">当前没有待确认的方案。</p>' : '';
      }
      const candidates = state.proposal.candidates || [];
      const analysis = state.candidateAnalysis?.proposalId === state.proposal.proposalId ? state.candidateAnalysis : null;
      return `
        ${inChat ? '<div class="page-head"><div><h2>待确认行动</h2></div></div>' : ''}
        ${state.candidateMutationPending ? '<p class="stop-meta" role="status">正在处理候选，请稍候……</p>' : ''}
        ${!inChat ? `<section class="card"><div class="row-between"><h3>方案对比 · ${candidates.length} 个</h3><button class="btn-soft" data-action="analyze-candidates" ${analysis?.pending ? 'disabled' : ''}>${analysis?.pending ? '正在比较……' : '伴途比较'}</button></div>${candidates.length > 1 ? comparisonTable(candidates) : '<p>选择两套方案后即可比较。</p>'}${analysis?.text ? `<div class="candidate-analysis"><h4>比较结果</h4><div class="message-markdown">${renderMessageMarkdown(analysis.text)}</div></div>` : ''}${analysis?.error ? `<p role="alert">${escapeHtml(analysis.error)}</p>` : ''}<p class="stop-meta">可以先存起来，之后再采用。</p></section>` : ''}
        ${candidates.map((candidate, index) => {
          const request = state.actionRequests.find((item) => item.candidateId === candidate.candidateId);
          const metrics = candidateMetrics(candidate);
          const unknown = (candidate.checks || []).filter((check) => check.status !== 'pass');
          const canApply = candidate.applicability === 'applicable' && Boolean(request) && !state.chatPending && !state.candidateMutationPending;
          return `<article class="candidate">
            <div class="row-between"><div><h4>方案 ${index + 1} · ${escapeHtml(candidate.title)}</h4><p>${escapeHtml(candidate.summary)}</p></div></div>
            <div class="metrics">
              <span class="chip">出发 ${metrics.departure === null ? '待定' : fmt(metrics.departure)}</span>
              <span class="chip">预计结束 ${metrics.leave === null ? '待定' : fmt(metrics.leave)}</span>
              <span class="chip">步行 ${metrics.walking === null ? '未知' : `${metrics.walking} 米`}</span>
              <span class="chip">费用 ${metrics.costUpper === null ? '未知' : `≤ ${(metrics.costUpper / 100).toFixed(0)} 元`}</span>
            </div>
            <ul class="change-list">${(candidate.changes || []).map((change) => `<li>${escapeHtml(change.summary)}</li>`).join('') || '<li>暂无结构变化说明</li>'}</ul>
            <div class="stop-meta">校验结果：${escapeHtml(APPLICABILITY_LABEL[candidate.applicability] || candidate.applicability)}${unknown.length ? ` · 待核实 ${unknown.length} 项` : ''}</div>
            <p class="stop-meta">${(candidate.snapshot.stops || []).filter(stop => stop.status === 'completed').length} 个已完成地点会保留。</p>
            ${unknown.map(check => check.explanation ? `<p class="stop-meta">${escapeHtml(check.explanation)}</p>` : '').join('')}
            <details><summary>查看完整计划（含已完成内容）</summary>${(candidate.snapshot.stops || []).map(stop => `<p>${escapeHtml(stop.place?.name || stop.stopId)} · ${itineraryTimeLabel(stop, candidate.snapshot)} · ${escapeHtml(STATUS_LABEL[stop.status] || '待进行')}</p>`).join('')}</details>
            <div class="stop-actions">
              <button class="btn-primary" data-action="apply" data-proposal="${escapeHtml(state.proposal.proposalId)}" data-candidate="${escapeHtml(candidate.candidateId)}" data-request="${escapeHtml(request?.actionRequestId || '')}" ${canApply ? '' : 'disabled'}>${inChat ? '确认调整计划' : '采用为计划'}</button>
              ${inChat ? '' : `<button class="btn-soft" data-action="save-candidate-plan" data-candidate="${escapeHtml(candidate.candidateId)}">存入计划</button>`}
            </div>
          </article>`;
        }).join('')}${candidates.length ? `<div class="stop-actions"><button class="btn-small btn-ghost" data-action="reject" ${state.chatPending || state.candidateMutationPending ? 'disabled' : ''}>放弃这组候选</button></div>` : ''}`;
    }

    function planMetricsSummary(plan) {
      // 方案是设计稿：出发/结束/步行/费用这些行程指标在载入执行前没有意义，这里只汇总地点数与游览时长。
      const days = plan.kind === 'scheme' ? (plan.days || []) : [{ stops: plan.stops }];
      const stops = days.flatMap(day => (day.stops || []).filter(stop => stop.status !== 'skipped'));
      if (!stops.length) return '暂无地点';
      const totalMinutes = stops.reduce((sum, stop) => sum + Math.min(720, Math.max(0, (stop.endMinutes ?? 0) - (stop.startMinutes ?? 0))), 0);
      const hours = Math.floor(totalMinutes / 60);
      const minutes = totalMinutes % 60;
      const duration = hours ? (minutes ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`) : `${minutes} 分钟`;
      return `共 ${stops.length} 个地点 · 游览合计约 ${duration}`;
    }

    function renderPlanLibrary() {
      // 方案候选只显示多天方案；载入生成的每日计划在「计划与进度」展示。
      const plans = (state.savedPlans || []).filter(plan => plan.kind === 'scheme');
      const dailyDraft = state.planDraft && (state.planDraft.dailyPlanDate || state.planDraft.planKind === 'plan' ||
        (state.savedPlans || []).some(plan => plan.id === state.planDraft.editId && plan.kind !== 'scheme'));
      const detachedDraft = state.planDraft && (planDraftNeedsNewScheme() ||
        (state.planDraft.editId && !(state.savedPlans || []).some(plan => plan.id === state.planDraft.editId)));
      const dayLines = (entry) => {
        const days = entry.kind === 'scheme' ? (entry.days || []) : [{ dayIndex: 0, stops: entry.stops, routeLegs: entry.routeLegs }];
        const orderedDays = days.map((day, index) => ({ day, index })).sort((left, right) =>
          (left.day.dayIndex ?? left.index) - (right.day.dayIndex ?? right.index));
        if (!orderedDays.length) return '<div class="scheme-day-preview"><p class="scheme-day-line">暂无内容</p></div>';
        const formatDay = ({ day, index }) => {
          const stops = (day.stops || []).map((stop, index) => ({ stop, index,
            start: [stop?.startMinutes, stop?.plannedStartMinutes, stop?.plannedArrivalMinutes, stop?.plannedDepartureMinutes, stop?.departureMinutes].find(Number.isFinite) ?? Number.POSITIVE_INFINITY,
          })).sort((left, right) => left.start - right.start || left.index - right.index).map(({ stop }) => stop);
          const dayNumber = Number.isInteger(day.dayIndex) ? day.dayIndex + 1 : index + 1;
          const visibleStops = stops.filter(stop => stop.status !== 'skipped');
          const names = visibleStops.map(stop => stop.place?.name || stop.stopId);
          const continuation = schemeDayContinuations(days, day.dayIndex ?? index)
            .map(item => `${escapeHtml(item.stop.place?.name || item.stop.stopId)}（跨日延续至 ${fmt(item.endMinutes)}）`).join('；');
          const route = [continuation, names.map(escapeHtml).join(' → ')].filter(Boolean).join('；') || '暂无地点';
          if (names.length > 3 || names.join(' → ').length > 45) {
            // 折叠态只报天数和站点数；截断的站名预览既看不全又容易误读，展开后才有完整路线。
            return `<details class="scheme-route-preview"><summary title="展开第 ${dayNumber} 天的完整地点">第 ${dayNumber} 天 · ${names.length} 个地点</summary><p class="scheme-day-line">${route}</p></details>`;
          }
          return `<p class="scheme-day-line">第 ${dayNumber} 天：${route}</p>`;
        };
        const visibleDays = orderedDays.slice(0, 3);
        const remainingDays = orderedDays.slice(3);
        return `<div class="scheme-day-preview">${visibleDays.map(formatDay).join('')}${remainingDays.length ? `<details class="scheme-day-more"><summary>… 还有 ${remainingDays.length} 天</summary><div class="scheme-day-hidden">${remainingDays.map(formatDay).join('')}</div></details>` : ''}</div>`;
      };
      const compareCount = selectedComparisonSchemes().length;
      const compareLabel = comparisonButtonLabel(compareCount);
      const compareBtn = plans.length >= 2 ? `<button class="action-icon" data-action="compare-schemes" aria-label="${compareLabel}" data-count="${compareCount}" ${compareCount >= 2 ? '' : 'disabled'} aria-disabled="${compareCount < 2}" title="${compareLabel}">${uiIcon('compare', { size: 20 })}</button>` : '';
      return `<section class="plan-library"><div class="row-between row-center plan-library-head"><h3>我的方案（${hasLoadError('plans') ? '暂未加载' : plans.length}）</h3><div class="stop-actions">${(state.savedPlans || []).some(plan => plan.kind === 'plan') ? `<button class="action-icon" data-action="save-current-plan" title="把日期计划存入方案库" aria-label="把日期计划存入方案库">${uiIcon('archive', { size: 20 })}</button>` : ''}${compareBtn}<button class="action-icon action-icon-create" data-action="new-plan-draft" title="新建方案" aria-label="新建方案">${uiIcon('document-add', { size: 22 })}</button></div></div>
      ${detachedDraft ? renderPlanDraft() : dailyDraft ? `<div class="notice plan-draft-resume"><div><strong>「${escapeHtml(state.planDraft.name || '日计划')}」的编辑草稿已保留。</strong><p data-plan-draft-status role="status">${escapeHtml(planDraftStatus())}</p></div><button class="btn-soft" data-action="resume-plan-draft">继续编辑日计划</button></div>` : state.planDraft && !state.planDraft.editId ? renderPlanDraft() : ''}
      <div class="scheme-card-grid">${plans.map(plan => {
        const dayCount = plan.kind === 'scheme' ? (plan.days || []).length : 1;
        const today = dateKeyInTimeZone(new Date(), plan.timezone || 'Asia/Shanghai');
        const expiredDate = Boolean(plan.localDate && plan.localDate < today);
        const dateText = plan.localDate
          ? `${monthDay(plan.localDate)}${expiredDate ? (plan.kind === 'scheme' ? ' · 设置开始日期' : ' · 已过期，点击改期') : ''}`
          : (plan.kind === 'scheme' ? '设置开始日期' : '日期待定');
        const selected = state.compareSelection.has(plan.id);
        const cardHeading = schemeCardHeading(plan);
        return `<article class="candidate ${selected ? 'compare-selected' : ''}"><div class="row-between"><div class="scheme-card-copy"><h4 title="${escapeHtml(plan.name)}">${escapeHtml(cardHeading.title)}</h4>${cardHeading.metadata ? `<p class="scheme-origin-meta">${escapeHtml(cardHeading.metadata)}</p>` : ""}${dayLines(plan)}</div><div class="stop-actions" style="margin:0;align-items:center"><button class="action-icon labeled-action${selected ? ' is-selected' : ''}" data-action="toggle-compare" title="${selected ? '取消方案对比' : '加入方案对比'}" aria-label="${selected ? '取消方案对比' : '加入方案对比'}" data-plan="${escapeHtml(plan.id)}" aria-pressed="${selected ? 'true' : 'false'}">${buttonContent('compare', selected ? '已加入' : '加入对比')}</button></div></div>
        <p class="stop-meta">${planMetricsSummary(plan)}</p>
        <footer class="scheme-card-footer"><div class="stop-actions scheme-icon-actions">${plan.kind === 'scheme' ? `<button class="action-icon action-icon-primary labeled-action" data-action="load-scheme" data-scheme="${escapeHtml(plan.id)}" aria-label="载入方案：${escapeHtml(plan.name)}">${uiIcon('load', { size: 18 })}<span>载入</span></button>` : ''}<button class="action-icon labeled-action" data-action="edit-saved-plan" data-plan="${escapeHtml(plan.id)}" aria-label="编辑方案：${escapeHtml(plan.name)}">${uiIcon('edit', { size: 18 })}<span>编辑</span></button><button class="action-icon action-icon-danger labeled-action" data-action="delete-saved-plan" data-plan="${escapeHtml(plan.id)}" aria-label="删除方案：${escapeHtml(plan.name)}">${uiIcon('trash', { size: 18 })}<span>删除</span></button>${plan.kind === 'scheme' ? `<button class="action-icon action-icon-share labeled-action" data-action="share-plan-to-community" data-plan="${escapeHtml(plan.id)}" aria-label="分享方案：${escapeHtml(plan.name)}">${uiIcon('share', { size: 18 })}<span>分享</span></button>` : ''}</div><div class="scheme-meta-line scheme-card-meta"><span class="chip green">${dayCount} 天</span><button class="chip scheme-date" data-action="edit-scheme-date" data-plan="${escapeHtml(plan.id)}" data-date="${escapeHtml(plan.localDate || '')}" title="点击修改起始日期">${escapeHtml(dateText)}</button></div></footer></article>${state.planDraft && state.planDraft.editId === plan.id ? renderPlanDraft() : ''}`;
      }).join('') || (hasLoadError('plans') ? '<p class="stop-meta">方案没加载出来。</p>' : '<p class="stop-meta">还没有方案。点右上角的新建方案按钮，按天添加地点。</p>')}
      </div></section>`;
    }

    // 计划编辑器的地点选择器使用合并目录：全量目录（placeCatalog）优先，
    // 其次地图目录，最后地点页当前列表。地点页的搜索/筛选只应影响地点页，
    // 不能把「添加地点」下拉缩成搜索命中的少数结果。
    function planPlaceChoices() {
      const seen = new Set();
      const list = [];
      for (const place of [...(state.placeCatalog || []), ...(state.mapPlaces || []), ...(state.places || [])]) {
        if (!place?.placeId || seen.has(place.placeId)) continue;
        seen.add(place.placeId);
        list.push(place);
      }
      return list;
    }

    export function renderPlanDraft({ dailyOnly = false } = {}) {
      const draft = state.planDraft;
      if (!draft) return '';
      const needsNewScheme = planDraftNeedsNewScheme(draft);
      const editingPlan = (state.savedPlans || []).find(plan => plan.id === draft.editId);
      const dailyPlanLabel = dailyOnly || (draft.editId && (draft.planKind || editingPlan?.kind) !== 'scheme');
      const day = draft.days[draft.activeDay] || draft.days[0];
      const continuations = dailyOnly || draft.planKind === 'plan' || draft.dailyPlanDate ? [] : schemeDayContinuations(draft.days, day.dayIndex);
      const routes = planRouteSummary(day);
      const unknownTravelCount = draft.days.reduce((sum, item) => sum + planRouteSummary(item).unknown, 0);
      const dayTiles = draft.days.map(d => {
        const placeCount = d.stops.filter(stop => stop.status !== 'skipped').length;
        const ongoing = schemeDayContinuations(draft.days, d.dayIndex).length;
        const isEmpty = placeCount === 0 && !ongoing;
        const label = placeCount ? `${placeCount} 个地点${ongoing ? ' · 延续' : ''}` : ongoing ? '跨日延续' : '待安排';
        return `<button class="plan-day-tile${isEmpty ? ' is-empty' : ''}${d.dayIndex === day.dayIndex ? ' active' : ''}" data-action="plan-draft-day" data-day="${d.dayIndex}" aria-label="第 ${d.dayIndex + 1} 天，${label}" aria-pressed="${d.dayIndex === day.dayIndex ? 'true' : 'false'}"><strong>${d.dayIndex + 1}</strong><span class="plan-day-status${isEmpty ? ' is-pending' : ' is-scheduled'}">${label}</span></button>`;
      }).join('');
      // 下拉只显示地点名，编号不再混入（找地点时支持按名称/ID 搜索）。
      const options = planPlaceChoices().map(place => `<option value="${escapeHtml(place.placeId)}">${escapeHtml(place.name)}</option>`).join('');
      return `<section class="card planner-inline"><div class="row-between row-center"><h3>${needsNewScheme ? '保留的编辑草稿' : dailyOnly ? draft.editId ? '编辑日计划' : '创建日计划' : draft.editId ? (dailyPlanLabel ? '编辑日计划' : '编辑方案') : '新建方案'}</h3><button class="btn-ghost" data-action="discard-plan-draft">放弃</button></div>
      <p class="plan-draft-storage-status" data-plan-draft-status role="status">${escapeHtml(planDraftStatus(draft))}</p>
      ${draft.dailyPlanDate && !draft.editId && draft.days.every(item => !item.stops.length) && dailyFirstStopMinutes(draft.dailyPlanDate, draft.timezone) > 20 * 60 ? '<div class="notice plan-night-hint"><span>今天所剩时间不多，首站会从下个整点或半点开始。也可以安排到明天白天。</span><button type="button" class="btn-soft" data-action="draft-next-day">改排明天</button></div>' : ''}
      ${needsNewScheme ? '<div class="planner-save-error" role="status"><p>原计划已移除或编辑日期已过去。草稿里的地点和时段仍在，可转为新方案继续安排。</p><button class="btn-soft" data-action="draft-as-new-scheme">转为新方案草稿</button></div>' : ''}
      <div class="field"><label for="draftName">${dailyOnly || draft.planKind === 'plan' ? '计划名称' : '方案名称'}</label><input id="draftName" maxlength="40" value="${escapeHtml(draft.name || '')}" placeholder="例如：轻松版"></div>
      ${dailyOnly ? '' : `<div class="field"><label>起始日期（可留空＝日期待定）</label><input id="draftStartDate" type="date" value="${escapeHtml(draft.localDate || '')}" hidden><button type="button" class="btn-soft scheme-date-btn${draft.localDate ? '' : ' placeholder'}" data-action="edit-draft-date">${escapeHtml(draft.localDate ? monthDay(draft.localDate) : '日期待定')}</button></div>
      <div class="plan-day-count-control"><label for="draftDayCount">总天数</label><input id="draftDayCount" type="number" min="1" max="${Math.max(366, draft.days.length)}" step="1" value="${draft.days.length}" aria-label="方案总天数"><span>天</span></div>
      <div class="plan-day-grid" role="group" aria-label="选择要编辑的日期">${dayTiles}</div>`}
      <h4 class="plan-day-editor-title">第 ${day.dayIndex + 1} 天安排</h4>
      ${continuations.map(item => `<article class="scheme-day-continuation"><div><strong>${escapeHtml(item.stop.place?.name || item.stop.stopId)}</strong><p>第 ${item.sourceDay + 1} 天的游览延续至 ${fmt(item.endMinutes)} · 同一次到访</p></div><button class="btn-soft" data-action="plan-draft-day" data-day="${item.sourceDay}">调整原安排</button></article>`).join('')}
      ${day.stops.map((stop, index) => {
        const duration = Math.max(0, Math.min(720, stop.endMinutes - stop.startMinutes));
        const hours = Math.floor(duration / 60), minutes = duration % 60;
        const durationText = hours ? `${hours}小时${minutes ? `${minutes}分` : ''}` : `${minutes}分钟`;
        const durationShort = hours ? `${hours}时${minutes ? `${minutes}分` : ''}` : `${minutes}分`;
        const placeName = stop.place?.name || stop.stopId;
        const previous = [...day.stops.slice(0, index)].reverse().find(item => item.status !== 'skipped');
        const segment = routes.segments.find(item => item.stop === stop);
        const mode = transportModeToStop(day, stop, previous);
        const travelText = stop.status === 'skipped' ? '已跳过' : !previous ? '首站 · 出发时估算' : day.routePending && segment?.minutes === null ? '正在估算' : segment?.minutes === null ? '道路时间待估' : `约 ${segment.minutes} 分钟`;
        return `<article class="candidate planner-stop" data-plan-stop="${escapeHtml(stop.stopId || '')}">
          <button class="planner-stop-remove action-icon action-icon-danger" data-action="plan-draft-remove" data-index="${index}" aria-label="移除 ${escapeHtml(placeName)}" title="移除地点">${uiIcon('trash', { size: 20 })}</button>
          <strong class="planner-stop-name">${escapeHtml(placeName)}</strong>
          <div class="planner-stop-time-pill" aria-label="${fmt(stop.startMinutes)} 至 ${fmt(stop.endMinutes)}，停留 ${durationText}">
            <button class="planner-stop-start" data-action="edit-draft-stop-time" data-day="${day.dayIndex}" data-index="${index}" data-stop-id="${escapeHtml(stop.stopId || '')}" aria-label="修改 ${escapeHtml(placeName)} 的开始时间" title="修改开始时间">${fmtWithDay(stop.startMinutes)}</button>
            <span aria-hidden="true">·</span>
            <button class="planner-stop-duration" data-action="edit-draft-stop-duration" data-day="${day.dayIndex}" data-index="${index}" data-stop-id="${escapeHtml(stop.stopId || '')}" aria-label="选择 ${escapeHtml(placeName)} 的停留时长" title="选择停留时长">${durationShort}</button>
          </div>
          <div class="planner-stop-order"><button class="action-icon" data-action="plan-draft-move" data-index="${index}" data-dir="-1" ${index === 0 ? 'disabled' : ''} aria-label="上移" title="上移地点">${uiIcon('arrow-up', { size: 20 })}</button><button class="action-icon" data-action="plan-draft-move" data-index="${index}" data-dir="1" ${index === day.stops.length - 1 ? 'disabled' : ''} aria-label="下移" title="下移地点">${uiIcon('arrow-down', { size: 20 })}</button></div>
          <div class="planner-stop-travel"><span class="planner-stop-travel-label">前往此处</span>${transportPickerHtml(mode, { action: 'draft-stop-transport-mode', data: { day: day.dayIndex, stop: stop.stopId }, compact: true, disabled: stop.status && stop.status !== 'planned', label: `选择前往${placeName}的交通方式` })}<span class="planner-stop-travel-time" role="status">${escapeHtml(travelText)}</span>${previous && segment?.minutes === null && !day.routePending && stop.status !== 'skipped' ? `<button type="button" class="planner-stop-route-retry" data-action="retry-draft-stop-route" data-day="${day.dayIndex}" data-stop="${escapeHtml(stop.stopId)}">重试</button>` : ''}</div>
        </article>`;
      }).join('') || (continuations.length ? '<p class="stop-meta">可在延续游览结束后，继续安排这一天的地点。</p>' : '<p class="stop-meta">这一天还没有地点，从下方添加开始。</p>')}
      <div class="stop-actions draft-add-place-row"><select id="draft-add-place-select" aria-label="添加地点" data-ui="picker">${options}</select><button class="action-icon action-icon-create" data-action="draft-add-place" title="添加到草稿" aria-label="添加到草稿">${uiIcon('pin-add', { size: 22 })}</button></div>
      ${day.timeError ? `<p class="stop-meta" role="alert" style="color:var(--red)">${escapeHtml(day.timeError)}</p>` : ''}
      ${draft.saveError ? `<p class="planner-save-error" role="alert">${escapeHtml(draft.saveError)} 草稿已保留，尚未覆盖已保存的内容。</p>` : ''}
      ${draft.saveNotice ? `<p class="stop-meta" role="status">${escapeHtml(draft.saveNotice)}</p>` : ''}
      ${day.routeWarning ? `<p class="stop-meta plan-route-warning" role="status">${escapeHtml(day.routeWarning)}</p>` : ''}
      <div class="stop-actions"><button class="btn-primary planner-save" data-action="save-plan-draft" ${draft.saving || needsNewScheme || draft.days.some(day => day.routePending) ? 'disabled' : ''}><span>${draft.saving ? '正在保存…' : dailyOnly ? '保存' : '保存方案'}</span>${unknownTravelCount ? `<span class="planner-save-status">${unknownTravelCount} 段交通待估</span>` : ''}</button></div></section>`;
    }

function comparisonTable(candidates) {
  const rows = [
    ['路线顺序', c => (c.snapshot.stops || []).filter(s => s.status !== 'skipped').map(s => s.place?.name || s.stopId).join(' → ') || '暂无地点'],
    ['出发时间', c => { const m = candidateMetrics(c); return m.departure === null ? '待定' : fmt(m.departure); }],
    ['预计结束时间', c => { const m = candidateMetrics(c); return m.leave === null ? '待定' : fmt(m.leave); }],
    ['步行距离', c => { const m = candidateMetrics(c); return m.walking === null ? '未知' : `${m.walking} 米`; }],
    ['费用上限', c => { const m = candidateMetrics(c); return m.costUpper === null ? '未知' : `${(m.costUpper / 100).toFixed(0)} 元`; }],
    ['调整说明', c => (c.changes || []).map(change => change.summary).join('；') || c.summary || '无'],
    ['校验结果', c => APPLICABILITY_LABEL[c.applicability] || c.applicability],
    ['风险与待核实', c => (c.checks || []).filter(check => check.status !== 'pass').map(check => check.explanation || '待核实').join('；') || '当前校验未发现问题'],
  ];
  return `<p class="comparison-scroll-hint stop-meta">左右滑动表格，查看不同方案</p><div class="candidate-comparison" tabindex="0" role="region" aria-label="候选方案横向对比"><table><thead><tr><th scope="col">对比项</th>${candidates.map((c,i) => `<th scope="col">方案 ${i+1} · ${escapeHtml(c.title)}</th>`).join('')}</tr></thead><tbody>${rows.map(([label,renderCell]) => `<tr><th scope="row">${label}</th>${candidates.map(c => `<td>${escapeHtml(renderCell(c))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
