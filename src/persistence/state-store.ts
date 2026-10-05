import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface StateStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  /** 一次写入多个键；实现应保证原子性，避免崩溃后留下撕裂的快照。 */
  setMany(entries: Array<[string, string]>, expectedRevision?: number): number | undefined;
  /** SQLite 快照代次；内存存储没有跨实例共享代次。 */
  getRevision?(): number;
  delete(key: string): void;
  close(): void;
}

export class StateStoreConflictError extends Error {
  constructor(readonly expectedRevision: number, readonly actualRevision: number) {
    super(`State snapshot changed (expected ${expectedRevision}, found ${actualRevision}).`);
    this.name = 'StateStoreConflictError';
  }
}

export class MemoryStateStore implements StateStore {
  private readonly values = new Map<string, string>();

  get(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  set(key: string, value: string): void {
    this.values.set(key, value);
  }

  setMany(entries: Array<[string, string]>): number | undefined {
    for (const [key, value] of entries) this.values.set(key, value);
    return undefined;
  }

  delete(key: string): void {
    this.values.delete(key);
  }

  close(): void {
    this.values.clear();
  }
}

/**
 * 本地持久化适配器：用于离线恢复演练，不替代生产 PostgreSQL。
 * 同一 StateStore 接口可替换为数据库事务实现。
 */
export class SqliteStateStore implements StateStore {
  private readonly database: DatabaseSync;

  private readonly selectStatement;

  private readonly upsertStatement;

  private readonly deleteStatement;

  private readonly revisionStatement;

  constructor(fileName: string) {
    if (fileName !== ':memory:') {
      mkdirSync(dirname(fileName), { recursive: true });
    }
    this.database = new DatabaseSync(fileName);
    this.database.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS app_state_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        revision INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO app_state_meta (id, revision) VALUES (1, 0);
      CREATE TRIGGER IF NOT EXISTS app_state_revision_insert
      AFTER INSERT ON app_state BEGIN
        UPDATE app_state_meta SET revision = revision + 1 WHERE id = 1;
      END;
      CREATE TRIGGER IF NOT EXISTS app_state_revision_update
      AFTER UPDATE ON app_state BEGIN
        UPDATE app_state_meta SET revision = revision + 1 WHERE id = 1;
      END;
      CREATE TRIGGER IF NOT EXISTS app_state_revision_delete
      AFTER DELETE ON app_state BEGIN
        UPDATE app_state_meta SET revision = revision + 1 WHERE id = 1;
      END;
    `);
    // 语句只准备一次：每个响应都会落盘，重复 prepare 是纯开销。
    this.selectStatement = this.database.prepare('SELECT value FROM app_state WHERE key = ?');
    this.upsertStatement = this.database.prepare(
      `INSERT INTO app_state (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );
    this.deleteStatement = this.database.prepare('DELETE FROM app_state WHERE key = ?');
    this.revisionStatement = this.database.prepare('SELECT revision FROM app_state_meta WHERE id = 1');
  }

  get(key: string): string | null {
    const row = this.selectStatement.get(key) as { value?: string } | undefined;
    return row?.value ?? null;
  }

  getRevision(): number {
    const row = this.revisionStatement.get() as { revision?: number } | undefined;
    return Number(row?.revision ?? 0);
  }

  set(key: string, value: string): void {
    this.upsertStatement.run(key, value, new Date().toISOString());
  }

  /** 单事务写入：旅行/会话/任务/对话必须一起可见，否则崩溃会留下不一致的恢复点。 */
  setMany(entries: Array<[string, string]>, expectedRevision?: number): number {
    if (entries.length === 0) {
      const current = this.getRevision();
      if (expectedRevision !== undefined && current !== expectedRevision) {
        throw new StateStoreConflictError(expectedRevision, current);
      }
      return current;
    }
    const timestamp = new Date().toISOString();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const currentRevision = this.getRevision();
      if (expectedRevision !== undefined && currentRevision !== expectedRevision) {
        throw new StateStoreConflictError(expectedRevision, currentRevision);
      }
      for (const [key, value] of entries) {
        this.upsertStatement.run(key, value, timestamp);
      }
      // Triggers increment once per key write. Read before commit so a concurrent
      // instance cannot make this process adopt a revision for data it never loaded.
      const nextRevision = this.getRevision();
      this.database.exec('COMMIT');
      return nextRevision;
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch { /* 回滚失败时原始错误更有诊断价值 */ }
      throw error;
    }
  }

  delete(key: string): void {
    this.deleteStatement.run(key);
  }

  close(): void {
    this.database.close();
  }
}

export function createStateStoreFromEnv(env: NodeJS.ProcessEnv = process.env): StateStore | undefined {
  if (env.STATE_STORE !== 'sqlite') return undefined;
  return new SqliteStateStore(env.STATE_FILE ?? 'data/bantu-state.sqlite');
}
