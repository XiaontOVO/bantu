import { state } from './store.js';
import { compressPostImage } from './travel-journal.js';
import { render } from './render.js';
import { toast } from './ui.js';

export async function chooseAgentImages(input) {
  if (state.chatPending || state.chatImagesBusy) return;
  const files = Array.from(input.files || []);
  if (files.length > 4) { toast('最多选择 4 张照片', 'error'); return; }
  const principal = state.principal;
  state.chatImagesBusy = true;
  try {
    const images = [];
    for (const file of files) images.push({ dataUrl: await compressPostImage(file), alt: file.name.slice(0, 120) });
    if (state.principal === principal) state.chatImages = images;
  } catch (error) { toast(error.message, 'error'); }
  finally { state.chatImagesBusy = false; input.value = ''; render(); }
}
