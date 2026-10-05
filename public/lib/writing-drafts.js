import { state } from './store.js';

// 当前浏览器标签页内保存；按账号和写作对象隔离，不保存登录或配置表单。
const fallback = new Map();
export function writingDraft(kind, objectId) {
  const key = `bantu-writing:${state.principal?.principalId || 'guest'}:${kind}:${objectId}`;
  return {
    read() {
      // This page's newer input wins if persistence failed over an older value.
      if (fallback.has(key)) return fallback.get(key);
      try { return JSON.parse(sessionStorage.getItem(key) || 'null') || null; }
      catch { return null; }
    },
    save(value) {
      fallback.set(key, value);
      try { sessionStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
    },
    clearIf(value) {
      if (JSON.stringify(this.read()) !== JSON.stringify(value)) return;
      fallback.delete(key);
      try { sessionStorage.removeItem(key); } catch { fallback.set(key, null); }
    },
  };
}

export function retainWritingDraft(draft, fields, status) {
  const capture = () => ({
    ...(draft.read() || {}),
    ...Object.fromEntries(Object.entries(fields).map(([key, element]) => [key, element.value])),
  });
  Object.values(fields).forEach(element => element.addEventListener('input', () => {
    const persisted = draft.save(capture());
    status.textContent = persisted ? '草稿已暂存，关闭或刷新本标签页后可继续。尚未提交。' : '草稿已暂存，关闭后可继续；刷新可能丢失。';
  }));
  return capture;
}
