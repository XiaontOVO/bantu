import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
interface Account { username: string; nickname: string; actorId: string; salt: string; hash: string }
export class AccountService {
  private accounts: Account[] = [];
  serialize() { return JSON.stringify(this.accounts); }
  loadSerialized(value: string) {
    this.accounts = JSON.parse(value);
    // 旧落盘账号没有昵称字段；默认与账号名一致。
    for (const account of this.accounts) {
      if (typeof account.nickname !== 'string' || !account.nickname.trim()) account.nickname = account.username;
    }
  }
  profile(actorId: string) {
    const account = this.accounts.find(item => item.actorId === actorId);
    return account ? { username: account.username, nickname: account.nickname, kind: 'account' } : { kind: 'anonymous' };
  }
  /** 社区展示昵称；匿名身份没有账号昵称，返回空串由调用方回退。 */
  nicknameOf(actorId: string) { return this.accounts.find(item => item.actorId === actorId)?.nickname ?? ''; }
  setNickname(actorId: string, value: unknown) {
    const account = this.accounts.find(item => item.actorId === actorId);
    if (!account) throw new Error('注册或登录账号后才能修改社区昵称。');
    const nickname = typeof value === 'string' ? value.trim() : '';
    if (!nickname || nickname.length > 30) throw new Error('昵称需填写 1–30 个字。');
    account.nickname = nickname;
    return { nickname: account.nickname };
  }
  register(username: unknown, password: unknown, actorId: string) {
    const name = String(username || '').trim().toLowerCase();
    if (!/^[a-z0-9_]{3,24}$/.test(name)) throw new Error('账号需为 3–24 位英文字母、数字或下划线。');
    if (typeof password !== 'string' || password.length < 8 || password.length > 128) throw new Error('密码需为 8–128 位。');
    if (this.accounts.some(item => item.username === name || item.actorId === actorId)) throw new Error('账号已存在，或当前身份已经注册。');
    const salt = randomBytes(16).toString('hex');
    this.accounts.push({username:name,nickname:name,actorId,salt,hash:scryptSync(password,salt,64).toString('hex')});
    return actorId;
  }
  login(username: unknown, password: unknown) {
    if (typeof password !== 'string' || password.length > 128) throw new Error('账号或密码错误。');
    const account = this.accounts.find(item => item.username === String(username || '').trim().toLowerCase());
    const hash = scryptSync(password, account?.salt || 'missing-account-salt',64);
    if (!account || !timingSafeEqual(hash, Buffer.from(account.hash,'hex'))) throw new Error('账号或密码错误。');
    return account.actorId;
  }
}
