import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('login and registration use a keyboard-submittable form with matching server constraints', async () => {
  const account = await readFile(`${process.cwd()}/public/lib/account.js`, 'utf8');
  const app = await readFile(`${process.cwd()}/public/app.js`, 'utf8');

  assert.match(account, /<form data-account-form>/, '账号输入应放在原生表单中，支持 Enter 提交');
  assert.match(account, /id="accountUsername"[^>]*required/);
  assert.match(account, /id="accountUsername"[^>]*pattern="\[A-Za-z0-9_\]\{3,24\}"/);
  assert.match(account, /id="accountPassword"[^>]*minlength="8"[^>]*maxlength="128"[^>]*required/);
  assert.match(account, /type="submit" value="login">登录/);
  assert.match(account, /type="submit" value="register">注册并保留当前数据/);

  assert.match(app, /event\.target\.matches\('\[data-account-form\]'\)/);
  assert.match(app, /event\.preventDefault\(\);[\s\S]*event\.submitter\?\.value === 'register'/);
  assert.match(app, /await submitAccount\(mode, button\)/);
  assert.match(app, /sessionRecovery\?\.previousSessionInvalid \|\| sessionStorage\.getItem\('bantu:session-invalid'\)/);
  assert.doesNotMatch(app, /toast\('之前的会话已失效/, '失效会话只展示可关闭的恢复横幅，不重复弹出底部提示');
  assert.match(await readFile(`${process.cwd()}/public/lib/account-retention.js`, 'utf8'), /之前的会话已失效/);
  assert.match(await readFile(`${process.cwd()}/public/lib/api.js`, 'utf8'), /body\.data\?\.previousSessionInvalid/);
});
