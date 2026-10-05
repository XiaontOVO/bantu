import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpsRequest } from 'node:https';

/** Account-supplied endpoints must never reach this server's local network. */
export function isPublicModelAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113));
  }
  // Only IPv6 global unicast; exclude documentation, transition and mapped addresses.
  if (isIP(address) === 6) {
    const [prefix, second] = address.toLowerCase().split(':');
    return /^[23]/.test(address) && !(prefix === '2001' && (parseInt(second || '0', 16) < 0x200 || parseInt(second || '0', 16) === 0xdb8)) &&
      prefix !== '2002' && prefix !== '3fff';
  }
  return false;
}

export function publicModelUrl(value: unknown): URL {
  let url: URL;
  try { url = new URL(String(value || '').trim()); } catch { throw new Error('请填写完整的 API 地址。'); }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      url.href.length > 2048 || hostname === 'localhost' || hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') || (!hostname.includes('.') && !isIP(hostname)) ||
      (isIP(hostname) && !isPublicModelAddress(hostname))) {
    throw new Error('自行接入需使用公网 HTTPS 地址，不能包含密钥、查询参数或内网地址。');
  }
  return url;
}

/** Resolve and pin on EACH request; never follow redirects with a user's key. */
export async function resolvePublicModelTarget(hostname: string, resolve = (host: string) => lookup(host, { all: true })) {
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await resolve(hostname);
  if (!addresses.length || addresses.some(({ address }) => !isPublicModelAddress(address))) throw new Error('API 地址无法使用。');
  return addresses.find(({ family }) => family === 4) || addresses[0];
}

export const publicModelFetch: typeof fetch = async (input, init) => {
  const url = publicModelUrl(input instanceof Request ? input.url : String(input));
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const signal = init?.signal || AbortSignal.timeout(60000);
  signal.throwIfAborted();
  const target = await new Promise<Awaited<ReturnType<typeof resolvePublicModelTarget>>>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    resolvePublicModelTarget(hostname).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
  signal.throwIfAborted();
  const body = init?.body == null ? '' : String(init.body);
  if (Buffer.byteLength(body) > 24 * 1024 * 1024) throw new Error('请求内容过大。');
  return await new Promise<Response>((resolve, reject) => {
    const req = httpsRequest(url, {
      method: init?.method || 'POST', headers: Object.fromEntries(new Headers(init?.headers).entries()),
      family: target.family,
      signal,
      // Preserve URL hostname for TLS/SNI; socket can only connect to the checked IP.
      lookup: (_host, _options, callback) => callback(null, target.address, target.family),
    }, res => {
      const status = res.statusCode || 502;
      if (status >= 300 && status < 400) { res.resume(); resolve(new Response(null, { status })); return; }
      const chunks: Buffer[] = []; let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) { res.destroy(new Error('模型响应过大。')); return; }
        chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => resolve(new Response(status === 204 || status === 205 || status === 304 ? null : Buffer.concat(chunks), { status })));
    });
    req.on('error', reject);
    req.end(body);
  });
};
