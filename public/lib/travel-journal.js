import { writingDraft, retainWritingDraft } from './writing-drafts.js';
import { api } from './api.js';
import { $, state, tripId, usesSavedDayPlans } from './store.js';
import { escapeHtml } from './format.js';
import { openSheet, closeSheet, toast } from './ui.js';
import { loadTrip, loadMemories, loadCommunity } from './loaders.js';
import { navigate, render, returnFromPost } from './render.js';
import { openAccount } from './account.js';
import { journeyPostSnapshot, renderJourneyPost } from './journey-post.js';
import { loadMorePostFeed } from './post-feed.js';
import { postPlaceResults } from './post-place-results.js';

let journalTrip, journalDate, busy = false, journalDraft, postDraft, captureJournal, capturePost, postJourneyMemory = null;
let postImages = [], postImageBusy = false, postPlaceIndex = new Map(), postSelectedPlaceIds = new Set(), postPlaceSearchSequence = 0, postPlaceSearchTimer = null;
let postCatalogPromise = null;
const MAX_POST_IMAGES = 4;
const MAX_POST_PLACE_REFS = 12;
const POST_IMAGE_TARGET_BYTES = 280 * 1024;
const heading = title => `<div class="sheet-head"><h3>${title}</h3><button data-action="close-sheet" aria-label="关闭">✕</button></div>`;

function blobDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('照片读取失败，请重新选择。'));
    reader.readAsDataURL(blob);
  });
}

function canvasBlob(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('照片压缩失败，请换一张试试。')), 'image/jpeg', quality);
  });
}

export async function compressPostImage(file) {
  if (!file.type.startsWith('image/') || file.type === 'image/svg+xml') throw new Error('请选择 JPG、PNG 或 WebP 照片。');
  if (file.size > 20 * 1024 * 1024) throw new Error('原照片不能超过 20 MB。');
  let bitmap;
  try { bitmap = await createImageBitmap(file); }
  catch { throw new Error('这张照片无法读取，请换一张试试。'); }
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 40_000_000) throw new Error('照片尺寸太大，请先缩小后再上传。');
    let width = bitmap.width, height = bitmap.height;
    const scale = Math.min(1, 1600 / Math.max(width, height));
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) throw new Error('浏览器暂时无法处理照片。');
    for (let resize = 0; resize < 4; resize += 1) {
      canvas.width = width; canvas.height = height;
      context.fillStyle = '#fff'; context.fillRect(0, 0, width, height);
      context.drawImage(bitmap, 0, 0, width, height);
      for (const quality of [0.82, 0.72, 0.62, 0.52]) {
        const blob = await canvasBlob(canvas, quality);
        if (blob.size <= POST_IMAGE_TARGET_BYTES) return await blobDataUrl(blob);
      }
      width = Math.max(1, Math.round(width * 0.78));
      height = Math.max(1, Math.round(height * 0.78));
    }
    throw new Error('这张照片暂时无法压缩到合适大小，请换一张试试。');
  } finally { bitmap.close?.(); }
}

function renderPostImageDrafts() {
  const preview = $('postImagePreview');
  if (!preview) return;
  preview.innerHTML = postImages.map((image, index) => `<figure class="post-image-draft"><img src="${escapeHtml(image.dataUrl)}" alt="${escapeHtml(image.alt || `旅行照片 ${index + 1}`)}"><button type="button" data-action="remove-post-image" data-image-index="${index}" aria-label="移除第 ${index + 1} 张照片">×</button></figure>`).join('');
  const count = $('postImageCount');
  if (count) count.textContent = `${postImages.length}/${MAX_POST_IMAGES}`;
}

function syncPostPlaceSelection(event) {
  const checkbox = event?.target;
  if (!checkbox?.matches?.('#postPlaceOptions input[type="checkbox"]')) return;
  const wasSelected = postSelectedPlaceIds.has(checkbox.value);
  if (checkbox.checked && !wasSelected && postSelectedPlaceIds.size >= MAX_POST_PLACE_REFS) {
    event.target.checked = false;
    const summary = $('postPlaceCount');
    if (summary) summary.textContent = `最多关联 ${MAX_POST_PLACE_REFS} 个地点`;
    return;
  }
  if (checkbox.checked) postSelectedPlaceIds.add(checkbox.value);
  else postSelectedPlaceIds.delete(checkbox.value);
  updatePostPlaceSelection();
  postDraft?.save(capturePost?.());
}

function updatePostPlaceSelection() {
  const ids = [...postSelectedPlaceIds].slice(0, MAX_POST_PLACE_REFS);
  const hidden = $('postPlaceIds');
  if (hidden) { hidden.value = ids.join(','); hidden.dispatchEvent(new Event('input', { bubbles: true })); }
  const summary = $('postPlaceCount');
  if (summary) summary.textContent = ids.length ? `已关联 ${ids.length} 个地点` : '还没有关联地点';
  const selected = $('postSelectedPlaces');
  if (selected) selected.innerHTML = ids.map(id => {
    const place = postPlaceIndex.get(id);
    const name = place?.name || '地点';
    return `<button type="button" class="post-place-selected" data-action="remove-post-place" data-place="${escapeHtml(id)}" aria-label="移除关联地点：${escapeHtml(name)}" title="${escapeHtml(name)}"><span class="post-place-selected-name">${escapeHtml(name)}</span><span aria-hidden="true">×</span></button>`;
  }).join('');
}

async function searchPostPlaces(query, sequence) {
  const options = $('postPlaceOptions');
  if (!options || sequence !== postPlaceSearchSequence) return;
  if (!query) { options.innerHTML = '<p class="post-place-empty">输入地点名称搜索并添加。</p>'; return; }
  options.innerHTML = '<p class="post-place-empty">正在搜索地点…</p>';
  try {
    const params = new URLSearchParams({ query, cityCode: state.placeCity || '', limit: '50' });
    const owner = state.principal?.principalId;
    if (!postCatalogPromise) postCatalogPromise = (async () => {
      const catalog = []; let cursor = '';
      do {
        const page = await api(`/api/v1/places?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, {}, true);
        catalog.push(...(page.data || [])); cursor = page.meta?.nextCursor || '';
      } while (cursor && catalog.length < 5000);
      return catalog;
    })();
    const [catalogResult, searchResult] = await Promise.allSettled([postCatalogPromise, api(`/api/v1/places?${params}`, {}, true)]);
    if (sequence !== postPlaceSearchSequence || $('postPlaceOptions') !== options || owner !== state.principal?.principalId) return;
    if (catalogResult.status === 'rejected') postCatalogPromise = null;
    if (catalogResult.status === 'rejected' && searchResult.status === 'rejected') throw searchResult.reason;
    const { places, catalogIds } = postPlaceResults(catalogResult.status === 'fulfilled' ? catalogResult.value : [], searchResult.status === 'fulfilled' ? searchResult.value.data || [] : [], query);
    places.forEach(place => postPlaceIndex.set(place.placeId, place));
    options.innerHTML = places.map(place => `<label class="post-place-option" data-place-name="${escapeHtml(place.name.toLowerCase())}" title="${escapeHtml(place.name)}"><input type="checkbox" value="${escapeHtml(place.placeId)}" ${postSelectedPlaceIds.has(place.placeId) ? 'checked' : ''}><span><b class="post-place-name">${escapeHtml(place.name)}</b><small>${catalogIds.has(place.placeId) ? '平台收录' : '地图地点'}${place.address ? ` · ${escapeHtml(place.address)}` : ''}</small></span></label>`).join('') || '<p class="post-place-empty">没有找到地点，换个名字试试。</p>';
    if (searchResult.status === 'rejected') options.insertAdjacentHTML('beforeend', '<p class="post-place-empty">地图搜索暂不可用，已展示匹配的平台地点。</p>');
    if (catalogResult.status === 'rejected') options.insertAdjacentHTML('beforeend', '<p class="post-place-empty">平台目录暂不可用，可重新搜索。</p>');
  } catch (error) {
    if (sequence === postPlaceSearchSequence && $('postPlaceOptions') === options) options.innerHTML = `<p class="post-place-empty">${escapeHtml(error.message || '地点搜索失败，请稍后重试。')}</p>`;
  }
}

export function removePostPlace(placeId) {
  if (!postSelectedPlaceIds.delete(placeId)) return;
  updatePostPlaceSelection();
  document.querySelectorAll('#postPlaceOptions input[type="checkbox"]').forEach(input => {
    if (input.value === placeId) input.checked = false;
  });
  postDraft?.save(capturePost?.());
}

async function addPostImages(input) {
  if (postImageBusy || !input?.files?.length) return;
  const targetDraft = postDraft, targetImages = postImages;
  const initialCount = targetImages.length;
  const files = [...input.files];
  input.value = '';
  const remaining = MAX_POST_IMAGES - targetImages.length;
  const status = $('postImageStatus');
  if (remaining <= 0) { if (status) status.textContent = `一篇帖子最多上传 ${MAX_POST_IMAGES} 张照片。`; return; }
  postImageBusy = true;
  input.disabled = true;
  const setStatus = value => { if (status?.isConnected) status.textContent = value; };
  try {
    if (files.length > remaining) throw new Error(`还可以添加 ${remaining} 张照片。`);
    for (const file of files) {
      setStatus(`正在处理照片：${file.name}`);
      const dataUrl = await compressPostImage(file);
      if (postDraft !== targetDraft || postImages !== targetImages) return;
      targetImages.push({ dataUrl, alt: `旅行照片 ${targetImages.length + 1}` });
    }
    if (postDraft !== targetDraft || postImages !== targetImages) return;
    renderPostImageDrafts();
    postDraft.save(capturePost());
    setStatus('照片已添加，发布后会随帖子一起显示。');
  } catch (error) {
    if (postDraft === targetDraft && postImages === targetImages && targetImages.length !== initialCount) {
      renderPostImageDrafts();
      targetDraft.save(capturePost());
    }
    setStatus(error.message);
  }
  finally { postImageBusy = false; input.disabled = false; }
}

export function removePostImage(index) {
  if (!Number.isInteger(index) || index < 0 || index >= postImages.length) return;
  postImages.splice(index, 1);
  renderPostImageDrafts();
  postDraft?.save(capturePost());
  if ($('postImageStatus')) $('postImageStatus').textContent = '已移除这张照片。';
}

export function dayJournalDraftId(tripId, date, tripStartDate) {
  // 起始日沿用旧 key，保证升级前尚未提交的草稿仍可恢复。
  return date === tripStartDate ? tripId : `${tripId}:${date}`;
}

export function dayJournalDates(trip, mountedDate) {
  // 无出行日期的草稿用旅行时区的服务端当前日作为隐式起始日。
  const tripStartDate = trip.snapshot.travelDate || trip.snapshot.localDate || trip.trip.localDate || trip.clock?.date || '';
  return { tripStartDate, journalDate: mountedDate || tripStartDate };
}

export function initialDayJournalText(trip, date, restoredText) {
  if (restoredText !== undefined && restoredText !== null) return restoredText;
  const anchorDate = trip.snapshot.travelDate || trip.snapshot.localDate || trip.trip.localDate || trip.clock?.date;
  const completed = (trip.snapshot.stops || []).filter(stop =>
    stop.status === 'completed' && (stop.date ?? anchorDate) === date,
  );
  return `${date} 旅行感想\n${completed.length ? `已完成：${completed.map(stop => stop.place?.name || stop.stopId).join('、')}\n\n` : ''}我的感想：\n`;
}

export function writeDayNote() {
  if (usesSavedDayPlans()) {
    journalTrip = '';
    journalDate = '';
    const actorKey = state.principal?.username || state.principal?.nickname || 'guest';
    journalDraft = writingDraft('journal', `personal:${actorKey}`);
    const restored = journalDraft.read();
    const text = restored?.text ?? '';
    openSheet(`${heading('写一条旅行记忆')}<p>记下旅途中的片段，之后可以继续编辑或删除。</p><label for="journalText">第一行是标题</label><textarea id="journalText" rows="8" placeholder="标题\n写下这段旅途里的见闻……">${escapeHtml(text)}</textarea><p id="journalDraftStatus" class="stop-meta">${restored ? '已恢复未提交的草稿。' : '草稿会自动保存在本机，保存后记入你的旅行记忆。'}</p><p id="journalStatus" role="status"></p><button class="btn-primary" data-action="save-day-note">保存随手记</button>`);
    captureJournal = retainWritingDraft(journalDraft, {text:$('journalText')}, $('journalDraftStatus'));
    return;
  }
  journalTrip = tripId();
  const { tripStartDate, journalDate: selectedDate } = dayJournalDates(state.trip, state.mountedDate);
  if (!selectedDate) throw new Error('当前旅行没有可用日期，暂时无法记录当天游记。');
  journalDate = selectedDate;
  journalDraft = writingDraft('journal', dayJournalDraftId(journalTrip, journalDate, tripStartDate));
  const restored = journalDraft.read();
  const text = initialDayJournalText(state.trip, journalDate, restored?.text);
  openSheet(`${heading('记录这一天')}<p>已填入当天完成的地点。写完后可保存为私人笔记，之后还能编辑或发到社区。</p><label for="journalText">第一行是标题</label><textarea id="journalText" rows="10">${escapeHtml(text)}</textarea><p id="journalDraftStatus" class="stop-meta">${restored ? '已恢复未提交的草稿。' : '草稿会自动保存，点击“保存为私人笔记”后才会记入旅行记忆。'}</p><p id="journalStatus" role="status"></p><button class="btn-primary" data-action="save-day-note">保存为私人笔记</button>`);
  captureJournal = retainWritingDraft(journalDraft, {text:$('journalText')}, $('journalDraftStatus'));
}
export async function saveDayNote(button) {
  if (busy) return;
  const savedDraft = journalDraft, capture = captureJournal, captured = capture(), input = $('journalText');
  const navigation = state.navigationRevision;
  const isEditorCurrent = () => journalDraft === savedDraft && captureJournal === capture && $('journalText') === input && state.navigationRevision === navigation;
  const text = captured.text.trim(), target = journalTrip;
  if (!text) throw new Error('请先填写笔记。');
  if (target ? target !== tripId() || usesSavedDayPlans() : !usesSavedDayPlans()) throw new Error('旅行已切换，请重新打开感想。');
  busy = true; button.disabled = true;
  try {
    if (!target) {
      const memory = await api('/api/v1/memories', {method:'POST', body:JSON.stringify({userText:text})});
      const unchanged = isEditorCurrent() && input.value === captured.text;
      savedDraft.clearIf(captured);
      const previousMemories = (state.memories || []).filter(item => item.tripId || item.memoryId !== memory.memoryId);
      state.memories = [...previousMemories, memory]
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      state.memoriesScope = `all+personal:${state.principal?.username || state.principal?.kind || 'guest'}`;
      if (unchanged) { closeSheet(); navigate('memories'); }
      else if (isEditorCurrent() && $('journalStatus')) $('journalStatus').textContent = '提交时的内容已保存；之后的修改仍在草稿中，请核对后再保存。';
      toast('随手记已保存，可继续编辑或删除');
      return;
    }
    await api(`/api/v1/trips/${target}/memories`, {method:'POST', body:JSON.stringify({userText:text, localDate:journalDate})});
    const unchanged = isEditorCurrent() && input.value === captured.text;
    savedDraft.clearIf(captured);
    if (unchanged) closeSheet();
    else if (isEditorCurrent() && $('journalStatus')) $('journalStatus').textContent = '提交时的内容已保存；之后的修改仍在草稿中，请核对后再保存。';
    if (tripId() === target) {
      // The note is already persisted. Refreshes are best effort so a short
      // read outage cannot report the save as failed or invite a duplicate.
      await Promise.allSettled([loadTrip(target), loadMemories()]);
      if (unchanged && state.navigationRevision === navigation && $('sheetBackdrop').hidden) navigate('memories');
    }
    toast('已保存为私人笔记，可继续编辑或预览并发帖');
  } catch (error) { if (isEditorCurrent() && $('journalStatus')) $('journalStatus').textContent = error.message; else toast(error.message, 'error'); }
  finally {busy = false; button.disabled = false;}
}
export async function writePost(memoryId, memoryTripId) {
  // 发帖是社区写操作：游客先登录，本地笔记不受影响。
  if (state.principal?.kind !== 'account') { openAccount('社区需登录后使用：登录或注册后即可发帖、评价、点赞与分享方案。'); return; }
  clearTimeout(postPlaceSearchTimer);
  postPlaceSearchTimer = null;
  postPlaceSearchSequence += 1;
  postCatalogPromise = null;
  const memoryScope = memoryTripId || (usesSavedDayPlans() ? '' : tripId()) || '';
  const memory = memoryId ? (state.memories || []).find(item => item.memoryId === memoryId && (item.tripId || '') === memoryScope) : null;
  if (memoryId && (!memory || memory.staleAt)) throw new Error('笔记不存在或来源已变化，请刷新。');
  postJourneyMemory = journeyPostSnapshot(memory, state.geoLabel);
  postDraft = writingDraft('post', memoryId ? `${memoryScope || 'personal'}:${memoryId}` : 'new');
  const restored = postDraft.read();
  const restoredPlaceIds = typeof restored?.placeIds === 'string' ? restored.placeIds.split(',').filter(Boolean) : [];
  postSelectedPlaceIds = new Set(restoredPlaceIds.slice(0, MAX_POST_PLACE_REFS));
  postPlaceIndex = new Map((state.places || []).map(place => [place.placeId, place]));
  for (const place of Array.isArray(restored?.placeRefs) ? restored.placeRefs : []) {
    if (typeof place?.placeId === 'string' && typeof place?.name === 'string') postPlaceIndex.set(place.placeId, place);
  }
  await Promise.all([...postSelectedPlaceIds].filter(id => !postPlaceIndex.has(id)).map(async id => {
    try { const place = await api(`/api/v1/places/${encodeURIComponent(id)}`); if (place?.placeId) postPlaceIndex.set(id, place); }
    catch { /* 已撤下或不可用的地点仍保留在草稿中，用户可移除。 */ }
  }));
  postImages = (Array.isArray(restored?.images) ? restored.images : [])
    .filter(image => typeof image?.dataUrl === 'string' && /^data:image\/(?:jpeg|png|webp);base64,/.test(image.dataUrl))
    .slice(0, MAX_POST_IMAGES);
  const author = `<div class="post-composer-author"><span>发布者</span><strong>${escapeHtml(state.principal?.nickname || state.principal?.username || '')}</strong><small>昵称可在「我的」页修改</small></div>`;
  const journeyPreview = postJourneyMemory
    ? `<div class="post-journey-share-preview"><p>路线卡预览</p>${renderJourneyPost(postJourneyMemory, { compact: true })}</div>`
    : '';
  const visibility = restored?.visibility === 'private' ? 'private' : 'public';
  openSheet(`${heading('预览并发布旅行帖子')}
    <div class="post-composer">
      <div class="post-composer-lede"><span>发布前预览</span><p>检查文字、地点和照片，并选择谁可以看到这篇帖子。</p></div>
      <div class="post-composer-layout">
        <div class="post-composer-main">
          <div class="post-composer-editor">
            <div class="post-composer-field-head"><label for="postText">帖子正文</label><span>第一行会作为标题</span></div>
            <textarea id="postText" rows="4" maxlength="10000" placeholder="先写标题，再记下旅途里的见闻…">${escapeHtml(restored?.text ?? memory?.userText ?? '')}</textarea>
            <p class="post-composer-editor-note">修改帖子不会改动原旅行记忆。</p>
          </div>
          ${journeyPreview}
        </div>
        <div class="post-composer-side">
          ${author}
          <section class="post-composer-section post-visibility-field">
            <label for="postVisibility">谁可以看</label>
            <select id="postVisibility"><option value="public" ${visibility === 'public' ? 'selected' : ''}>公开 · 社区可见</option><option value="private" ${visibility === 'private' ? 'selected' : ''}>仅自己可见</option></select>
            <p class="post-composer-hint">仅自己可见的帖子保存在「我的发布」，不会出现在社区，也无法通过链接被别人查看。</p>
          </section>
          <section class="post-composer-section" aria-labelledby="postPlacesTitle">
            <div class="post-composer-section-head"><div><strong id="postPlacesTitle">关联地点</strong><small>可多选，最多 ${MAX_POST_PLACE_REFS} 个</small></div><span id="postPlaceCount">${restoredPlaceIds.length ? `已关联 ${restoredPlaceIds.length} 个地点` : '尚未选择'}</span></div>
            <input id="postPlaceIds" type="hidden" value="${escapeHtml(restoredPlaceIds.join(','))}">
            <div id="postSelectedPlaces" class="post-place-selected-list"></div>
            <input id="postPlaceSearch" type="search" placeholder="搜索地点名称" aria-label="搜索可关联地点">
            <div id="postPlaceOptions" class="post-place-options"><p class="post-place-empty">输入地点名称搜索并添加。</p></div>
          </section>
          <section class="post-composer-section post-composer-photos" aria-labelledby="postImagesTitle">
            <div class="post-composer-section-head"><div><strong id="postImagesTitle">旅行照片</strong><small>最多 ${MAX_POST_IMAGES} 张</small></div><span id="postImageCount">${postImages.length}/${MAX_POST_IMAGES}</span></div>
            <label class="post-image-upload" for="postImageInput">＋ 选择照片</label>
            <input id="postImageInput" class="post-file-input" type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/avif" multiple>
            <p class="post-composer-hint">照片会压缩后保存在本机应用数据中。</p>
            <div id="postImagePreview" class="post-image-draft-grid"></div>
            <p id="postImageStatus" class="post-composer-hint" role="status"></p>
          </section>
        </div>
      </div>
      <footer class="post-composer-footer">
        <div class="post-composer-footer-copy"><strong id="postVisibilitySummary">${visibility === 'private' ? '仅自己可见' : '发布到社区'}</strong><p id="postDraftStatus">${restored ? '已恢复未发布的草稿，请检查内容。' : '内容会自动保存为草稿。'}</p></div>
        <div class="post-composer-footer-action"><p id="postStatus" role="status"></p><button class="btn-primary" data-action="publish-travel-post">发布帖子</button></div>
      </footer>
    </div>`);
  const draftFields = { text:$('postText'), placeIds:$('postPlaceIds'), visibility:$('postVisibility') };
  const captureFields = retainWritingDraft(postDraft, draftFields, $('postDraftStatus'));
  capturePost = () => ({
    ...captureFields(),
    placeRefs: [...postSelectedPlaceIds].map(id => postPlaceIndex.get(id)).filter(place => place?.placeId && place?.name)
      .map(place => ({ placeId: place.placeId, name: place.name })),
    images: postImages.map(image => ({ ...image })),
  });
  renderPostImageDrafts();
  updatePostPlaceSelection();
  $('postVisibility')?.addEventListener('change', event => {
    $('postVisibilitySummary').textContent = event.currentTarget.value === 'private' ? '仅自己可见' : '发布到社区';
    postDraft.save(capturePost());
  });
  $('postImageInput')?.addEventListener('change', event => addPostImages(event.currentTarget));
  $('postPlaceSearch')?.addEventListener('input', event => {
    clearTimeout(postPlaceSearchTimer);
    const query = event.currentTarget.value.trim();
    const sequence = ++postPlaceSearchSequence;
    postPlaceSearchTimer = setTimeout(() => searchPostPlaces(query, sequence), 220);
  });
  $('postPlaceOptions')?.addEventListener('change', syncPostPlaceSelection);
}
export async function publishPost(button) {
  if (busy) return;
  const savedDraft = postDraft, capture = capturePost, captured = capture(), input = $('postText');
  const navigation = state.navigationRevision;
  const isEditorCurrent = () => postDraft === savedDraft && capturePost === capture && $('postText') === input && state.navigationRevision === navigation;
  if (postImageBusy) { if ($('postImageStatus')) $('postImageStatus').textContent = '请等照片处理完成后再发布。'; return; }
  const selectedPlaceIds = new Set(String(captured.placeIds || '').split(',').filter(Boolean));
  const placeRefs = [...selectedPlaceIds].map(id => postPlaceIndex.get(id)).filter(place => place?.placeId && place?.name)
    .map(place => ({ placeId: place.placeId, name: place.name }));
  const { placeIds: _placeIds, placeRefs: _draftPlaceRefs, ...postContent } = captured;
  const body = { ...postContent, placeRefs, journeyMemory: postJourneyMemory };
  busy = true; button.disabled = true;
  try {
    await api('/api/v1/community/posts', {method:'POST', body:JSON.stringify(body)});
    const unchanged = isEditorCurrent() && JSON.stringify(capture()) === JSON.stringify(captured);
    savedDraft.clearIf(captured);
    if (unchanged) {
      state.communityPostFilter = body.visibility === 'private' ? 'mine' : 'all';
      postImages = [];
      closeSheet(); navigate('community');
    } else if (isEditorCurrent() && $('postStatus')) $('postStatus').textContent = '提交时的内容已发布；之后的修改仍在草稿中，请核对后再发布。';
    toast(body.visibility === 'private' ? '帖子已保存，仅自己可见' : '帖子已公开发布，原笔记保留');
  } catch(error) { if (isEditorCurrent() && $('postStatus')) $('postStatus').textContent = error.message; else toast(error.message, 'error'); }
  finally {busy = false; button.disabled = false;}
}
export function askWithdrawPost(id) {
  openSheet(`${heading('撤回这篇帖子？')}<p>撤回后社区不再展示，私人笔记仍保留。</p><button class="btn-danger" data-action="confirm-withdraw-post" data-post="${escapeHtml(id)}">确认撤回</button>`);
}
export async function openPostVisibility(id) {
  const post = await api(`/api/v1/community/posts/${encodeURIComponent(id)}`);
  if (!post.mine) throw new Error('只能修改自己帖子的可见范围。');
  openSheet(`${heading('帖子可见范围')}<div class="post-visibility-field"><label for="postVisibilityEdit">谁可以看</label><select id="postVisibilityEdit"><option value="public" ${post.visibility !== 'private' ? 'selected' : ''}>公开 · 社区可见</option><option value="private" ${post.visibility === 'private' ? 'selected' : ''}>仅自己可见</option></select><p class="stop-meta">设为仅自己可见后，正文、照片和评论只有你能查看，其他人的收藏中也会移除。</p></div><p id="postVisibilityStatus" role="status"></p><button class="btn-primary" data-action="save-post-visibility" data-post="${escapeHtml(id)}">保存设置</button>`);
}
export async function savePostVisibility(button) {
  if (busy) return;
  const id = button.dataset.post;
  const visibility = $('postVisibilityEdit')?.value;
  busy = true; button.disabled = true;
  try {
    const post = await api(`/api/v1/community/posts/${encodeURIComponent(id)}`, { method:'PATCH', body:JSON.stringify({visibility}) });
    if (state.postDetailId === id) state.postDetail = post;
    state.communityPosts = (state.communityPosts || []).filter(item => item.id !== id);
    if (post.visibility === 'public') state.communityPosts.unshift(post);
    const mine = state.communityMine || (state.communityMine = { posts:[], places:[], planShares:[] });
    mine.posts = [post, ...(mine.posts || []).filter(item => item.id !== id)];
    closeSheet(); render();
    toast(post.visibility === 'private' ? '已设为仅自己可见' : '已设为公开');
    await loadCommunity().catch(() => {});
    render();
  } catch(error) { if ($('postVisibilityStatus')) $('postVisibilityStatus').textContent = error.message; }
  finally { busy = false; button.disabled = false; }
}
export async function withdrawPost(id) {
  await api(`/api/v1/community/posts/${encodeURIComponent(id)}`, {method:'DELETE'});
  if (state.currentView === 'post-detail' && state.postDetailId === id) {
    closeSheet();
    returnFromPost();
    toast('帖子已撤回');
    return;
  }
  closeSheet(); await loadCommunity().catch(() => {}); render(); toast('帖子已撤回');
}
export async function morePosts() {
  const revision = state.navigationRevision, view = state.currentView;
  const request = loadMorePostFeed();
  render();
  try { await request; }
  catch { /* Keep the current list and its inline pagination retry. */ }
  finally { if (state.navigationRevision === revision && state.currentView === view) render(); }
}
