import { createHttpServer } from './http-server.js';
import { createAccessGate } from './http/access-gate.js';
import { createProviderBundle } from '../providers/factory.js';
import { createStateStoreFromEnv } from '../persistence/state-store.js';
import { ModelSettings } from '../services/model-settings.js';
import { UserModelSettings } from '../services/user-model-settings.js';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { loadEnvFile } from 'node:process';

if (existsSync('.env')) loadEnvFile('.env');

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '127.0.0.1';
// 真实账号测试默认不注入社区样例；需要演示数据时显式设置为 true。
const seedDemo = process.env.BANTU_SEED_DEMO === 'true';
const providers = createProviderBundle(process.env);
const stateStore = createStateStoreFromEnv(process.env);
const modelSettings = new ModelSettings('data/model-settings.json', providers.modelProvider);
const userModelSettings = new UserModelSettings('data/user-model-settings.json');

const accessGate = createAccessGate({ host });
const server = createHttpServer({
  seedDemo,
  accessGate,
  communityAdminToken: process.env.COMMUNITY_ADMIN_TOKEN,
  modelProvider: modelSettings.provider,
  modelSettings,
  userModelSettings,
  agentRequestLimits: { perMinute: Number(process.env.AGENT_REQUESTS_PER_MINUTE || 30), perDay: Number(process.env.AGENT_REQUESTS_PER_DAY || 300) },
  placeProvider: providers.placeProvider,
  requirePlaceImpressions: true,
  routeProvider: providers.routeProvider,
  weatherProvider: providers.weatherProvider,
  geoService: providers.geoService,
  stateStore,
});

// 崩溃留痕：本机原型没有外部日志系统，未捕获异常/拒绝写入 data/server-error.log，
// 便于追溯"服务为什么悄悄停了"；进程保持存活，继续服务后续请求。
const errorLogPath = 'data/server-error.log';
const logFatal = (kind: string, error: unknown): void => {
  try {
    const line = `[${new Date().toISOString()}] ${kind}: ${error instanceof Error ? (error.stack || error.message) : String(error)}\n`;
    appendFileSync(errorLogPath, line, { flag: 'a' });
    console.error(`[bantu] ${kind}:`, error);
  } catch { /* 日志失败也不中断服务 */ }
};
process.on('uncaughtException', (error) => logFatal('uncaughtException', error));
process.on('unhandledRejection', (reason) => logFatal('unhandledRejection', reason));

server.listen(port, host, () => {
  const issuedAt = new Date().toISOString();
  // 只保留当前开放信息，启动器核对 PID 后展示；不向网络提供邀请码。
  try {
    mkdirSync('data', { recursive: true });
    writeFileSync('data/lan-access.json', JSON.stringify({
      enabled: accessGate.enabled, processId: process.pid, port, host, issuedAt, code: accessGate.code,
    }, null, 2), 'utf8');
    writeFileSync('data/access-code.txt', accessGate.code ? `[${issuedAt}] ${accessGate.code}\n` : '局域网邀请访问未开放。\n', 'utf8');
  } catch (error) { console.error('[bantu] Cannot record current LAN invitation:', error); }
  console.log(`Bantu P0 prototype listening on http://${host}:${port}`);
  console.log(`health: http://${host}:${port}/api/v1/health`);
  console.log(
    `providers: model=${modelSettings.provider ? 'online' : 'scripted'} places=${
      providers.placeProvider.providerName
    } routes=${providers.routeProvider.providerName} state=${
      stateStore ? 'sqlite' : 'memory'
    }`,
  );
  if (seedDemo) {
    console.log('demo catalog and community samples enabled.');
  }
  if (accessGate.enabled && accessGate.code) {
    console.log('────────────────────────────────────────');
    console.log(`局域网已开放（邀请码门禁）。本次邀请码：${accessGate.code}`);
    console.log(`其他设备访问 http://<本机IP>:${port} 并输入邀请码；本机 127.0.0.1 免门禁。`);
    console.log('────────────────────────────────────────');
  }
});
