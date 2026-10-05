import { spawnSync } from 'node:child_process';
const url = new URL(process.argv[2]);
if (url.protocol !== 'https:' || !/^[a-z0-9.-]+$/i.test(url.hostname)) throw new Error('The invitation must use HTTPS.');
const check = address => {
  const result = spawnSync('curl.exe', ['--silent', '--show-error', '--connect-timeout', '3', '--max-time', '6',
    ...(address ? ['--resolve', `${url.hostname}:443:${address}`] : []), url.href], { encoding:'utf8', windowsHide:true, timeout:8000 });
  return result.status === 0 && result.stdout.includes('<form method="post" action="/__invite">');
};
let ready = check();
if (!ready) {
  // 只为本次验证查询独立 DNS；不改系统 DNS，也不写 hosts。仍核验真实域名 TLS 证书。
  const resolved = spawnSync('powershell.exe', ['-NoProfile','-Command',
    "@(Resolve-DnsName $env:BANTU_VERIFY_HOST -Server 1.1.1.1 -Type A -DnsOnly -QuickTimeout -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress } | Select-Object -ExpandProperty IPAddress) | ConvertTo-Json -Compress"],
    { env:{...process.env,BANTU_VERIFY_HOST:url.hostname}, encoding:'utf8', windowsHide:true, timeout:8000 });
  let addresses=[];
  try { const value=JSON.parse(resolved.stdout); addresses=Array.isArray(value)?value:[value]; } catch {}
  for (const address of addresses.filter(value => typeof value==='string' && /^(\d{1,3}\.){3}\d{1,3}$/.test(value)).slice(0,2)) {
    if (check(address)) {
      ready=true;
      console.log('HTTPS invitation verified using independent DNS. Campus DNS may block this domain; testers can use mobile data.');
      break;
    }
  }
}
process.exitCode=ready?0:1;
