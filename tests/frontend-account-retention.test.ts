import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const load = (path: string) => import(pathToFileURL(join(process.cwd(), path)).href) as Promise<Record<string, any>>;
const retention = await load('public/lib/account-retention.js');
const account = await load('public/lib/account.js');

test('guest guidance distinguishes registration, session loss and account-owned data without collecting a nickname', () => {
  const html = retention.guestRetentionNotice({ kind: 'anonymous', expiresAt: '2026-10-19T10:00:00Z' });
  assert.match(html, /游客记录尚未绑定账号/); assert.match(html, /往日记录/); assert.match(html, /会话有效至/);
  assert.match(html, /登录其他账号后/); assert.doesNotMatch(html, /<input/);
  assert.equal(retention.guestRetentionNotice({ kind: 'account' }), '');
  assert.equal(retention.guestRetentionNotice(null), '');
  assert.doesNotMatch(retention.guestRetentionNotice({ kind: 'anonymous', expiresAt: '<invalid>' }), /<invalid>|会话有效至/);
  const banner = retention.sessionRecoveryBanner(true);
  assert.match(banner, /登录原账号/); assert.match(banner, /未注册的游客资料无法自动找回/);
  assert.equal(retention.sessionRecoveryBanner(false), '');
});

test('a pending account request cannot switch twice and a late failure never writes into a replacement form', async () => {
  const backup = { fetch: globalThis.fetch, document: globalThis.document, window: globalThis.window };
  let finish!: (response: Response) => void, requests = 0;
  const username = { value: 'guest_owner', disabled: false }, password = { value: '12345678', disabled: false };
  const login = { disabled: false }, register = { disabled: false }, status = { textContent: '', isConnected: true }, toast = { textContent: '', className: '' };
  const replacement = { textContent: 'new form', isConnected: true };
  const nodes: Record<string, any> = { accountUsername: username, accountPassword: password, accountStatus: status, toast };
  try {
    globalThis.document = { getElementById: (id: string) => nodes[id], querySelectorAll: () => [login, register] } as any;
    globalThis.window = {} as any;
    globalThis.fetch = (() => { requests += 1; return new Promise<Response>(resolve => { finish = resolve; }); }) as typeof fetch;
    const pending = account.submitAccount('register', register);
    assert.ok(username.disabled && password.disabled && login.disabled && register.disabled);
    await account.submitAccount('login', login); assert.equal(requests, 1);
    status.isConnected = false; nodes.accountStatus = replacement;
    finish(new Response(JSON.stringify({ error: { code: 'ACCOUNT_INVALID', message: '账号已存在' } }), { status: 400 }));
    await pending;
    assert.equal(replacement.textContent, 'new form'); assert.equal(toast.textContent, '账号已存在');
    assert.ok(!username.disabled && !password.disabled && !login.disabled && !register.disabled);
    assert.equal(username.value, 'guest_owner'); assert.equal(password.value, '12345678');
  } finally { clearTimeout((globalThis.window as any).__toastTimer); globalThis.fetch = backup.fetch; globalThis.document = backup.document; globalThis.window = backup.window; }
});
