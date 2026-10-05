import { randomBytes, timingSafeEqual } from 'node:crypto';
import { request as proxyRequest, createServer } from 'node:http';

const appHost = process.env.BANTU_APP_HOST ?? '127.0.0.1';
const appPort = Number(process.env.BANTU_APP_PORT ?? 8787);
const listenHost = process.env.BANTU_GATE_HOST ?? '127.0.0.1';
const listenPort = Number(process.env.BANTU_GATE_PORT ?? 8788);
const normalizeCode = value => String(value ?? '').trim().replace(/[\s-]/g, '').toUpperCase();
const inviteCode = normalizeCode(process.env.BANTU_INVITE_CODE);

if (inviteCode.length < 8) {
  throw new Error('BANTU_INVITE_CODE must contain at least 8 characters.');
}
if (!Number.isInteger(appPort) || appPort < 1 || appPort > 65535 ||
    !Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) {
  throw new Error('Application and gateway ports must be valid TCP ports.');
}

const cookieName = 'bantu_invite';
// 每次启动重新签发通行凭证，即使外部误传了相同邀请码，也撤销上一轮通行。
const cookieValue = randomBytes(32).toString('base64url');
const expiresAt = Date.now() + 86400_000;
let failedAttempts = 0;
let attemptWindow = Date.now();
const unauthorizedPage = (invalid = false) => `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>伴途 · 邀请测试</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; color: #24332d; background: #f4f3ed; font-family: system-ui, "Microsoft YaHei", sans-serif; }
    main { width: min(100%, 420px); padding: 32px; border: 1px solid #e7e4da; border-radius: 22px; background: #fffefa; box-shadow: 0 18px 60px #293d2b12; }
    .brand { color: #567560; font-size: 13px; font-weight: 700; letter-spacing: .12em; }
    h1 { margin: 12px 0 8px; font-size: 25px; letter-spacing: -.03em; }
    p { margin: 0 0 24px; color: #72796f; line-height: 1.6; }
    label { display: block; margin-bottom: 8px; font-size: 13px; font-weight: 650; }
    input { width: 100%; height: 48px; padding: 0 14px; border: 1px solid #d9ddd4; border-radius: 12px; background: #fff; color: inherit; font: inherit; outline: none; }
    input:focus { border-color: #63856b; box-shadow: 0 0 0 3px #63856b22; }
    button { width: 100%; height: 48px; margin-top: 14px; border: 0; border-radius: 12px; color: white; background: #54765e; font: inherit; font-weight: 700; cursor: pointer; }
    button:hover { background: #46654f; }
    .error { margin: 12px 0 0; color: #a33b34; font-size: 13px; }
  </style>
</head>
<body>
  <main>
    <div class="brand">BANTU · PRIVATE TEST</div>
    <h1>输入访问授权码</h1>
    <p>这是伴途的小范围测试页面，请使用邀请时收到的授权码继续。</p>
    <form method="post" action="/__invite">
      <label for="code">授权码</label>
      <input id="code" name="code" type="password" autocomplete="one-time-code" required autofocus>
      <button type="submit">进入伴途</button>
      ${invalid ? '<div class="error" role="alert">授权码不正确，请再试一次。</div>' : ''}
    </form>
  </main>
</body>
</html>`;

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readCookie(header, name) {
  for (const part of (header ?? '').split(';')) {
    const splitAt = part.indexOf('=');
    if (splitAt < 0 || part.slice(0, splitAt).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(splitAt + 1).trim()); } catch { return ''; }
  }
  return '';
}

function sendInvitePage(response, invalid = false, status = 200) {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  response.end(unauthorizedPage(invalid));
}

function readForm(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > 4096) {
        reject(new Error('Request body too large.'));
        request.destroy();
      } else chunks.push(chunk);
    });
    request.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))));
    request.on('error', reject);
  });
}

const gateway = createServer(async (request, response) => {
  // 不信任 Host；畸形或伪造的域名不能使网关异常退出。
  let url;
  try { url = new URL(request.url ?? '/', 'http://bantu-invite.invalid'); }
  catch { response.writeHead(400); response.end('Invalid request.'); return; }

  if (url.pathname === '/__invite' && request.method === 'GET') {
    sendInvitePage(response, url.searchParams.has('invalid'));
    return;
  }

  if (url.pathname === '/__invite' && request.method === 'POST') {
    try {
      const form = await readForm(request);
      if (Date.now() - attemptWindow >= 60_000) { failedAttempts = 0; attemptWindow = Date.now(); }
      if (!safeEqual(normalizeCode(form.get('code')), inviteCode) || Date.now() >= expiresAt) {
        failedAttempts++;
        if (failedAttempts > 60) response.setHeader('retry-after', '60');
        sendInvitePage(response, true, failedAttempts > 60 ? 429 : 401);
        return;
      }
      response.writeHead(303, {
        location: '/',
        'cache-control': 'no-store',
        'set-cookie': `${cookieName}=${encodeURIComponent(cookieValue)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=86400`,
      });
      response.end();
    } catch {
      response.writeHead(400, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' });
      response.end('Invalid request.');
    }
    return;
  }

  const suppliedCookie = readCookie(request.headers.cookie, cookieName);
  if (!safeEqual(suppliedCookie, cookieValue) || Date.now() >= expiresAt) {
    if (url.pathname.startsWith('/api/')) {
      response.writeHead(401, { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' });
      response.end(JSON.stringify({error:{code:'ACCESS_CODE_REQUIRED',message:'请先打开首页输入本次邀请码；原通行可能已失效。'}}));
    } else sendInvitePage(response);
    return;
  }

  // 代理通过回环连接上游，但邀请访客不能因此取得本机模型设置权限。
  // 固定非本机 Host，拒绝客户端伪造 localhost / Origin 绕过上游限制。
  const headers = { ...request.headers, host: 'bantu-invite.invalid' };
  const appCookies = (request.headers.cookie ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith(`${cookieName}=`));
  if (appCookies.length) headers.cookie = appCookies.join('; ');
  else delete headers.cookie;
  delete headers.authorization;
  delete headers['x-forwarded-for'];
  delete headers['x-real-ip'];
  delete headers.forwarded;

  const upstream = proxyRequest({
    hostname: appHost,
    port: appPort,
    method: request.method,
    path: request.url,
    headers,
  }, (appResponse) => {
    const responseHeaders = { ...appResponse.headers };
    const setCookies = appResponse.headers['set-cookie'];
    if (setCookies) {
      responseHeaders['set-cookie'] = setCookies.map((cookie) =>
        /(?:^|;)\s*secure(?:;|$)/i.test(cookie) ? cookie : `${cookie}; Secure`,
      );
    }
    response.writeHead(appResponse.statusCode ?? 502, responseHeaders);
    appResponse.pipe(response);
  });
  upstream.on('error', () => {
    if (!response.headersSent) {
      response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    }
    response.end('伴途本机服务暂不可用。');
  });
  request.pipe(upstream);
});

gateway.listen(listenPort, listenHost, () => {
  console.log(`Bantu invite gateway listening on http://${listenHost}:${listenPort}`);
});
