/** Explicit offline reset of this workspace's user snapshots, retaining SQLite schemas. */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from 'node:net';

if (!process.argv.includes('--clear-user-data')) throw new Error('Requires --clear-user-data; stop the local server first.');
const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const data = realpathSync(join(root, 'data'));
assert.equal(data, join(root, 'data'));
assert.equal(existsSync(join(data, 'bantu-server.pid')), false, 'Run the workspace stop script first, including services launched on another port.');
const listening = await new Promise(resolve => {
  const socket = connect({ host: '127.0.0.1', port: 8787 });
  socket.setTimeout(1000);
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', error => { socket.destroy(); resolve(error.code !== 'ECONNREFUSED'); });
  socket.once('timeout', () => { socket.destroy(); resolve(true); });
});
assert.equal(listening, false, 'Stop the local application before clearing snapshots.');
const paths = ['bantu-state.sqlite', 'bantu-sandbox.sqlite', 'bantu-state-before-post-cleanup-20260921-092515.sqlite']
  .map(name => join(data, name)).filter(existsSync);
// Validate every database before making the first change. No directory traversal or arbitrary path flags.
for (const path of paths) {
  assert.equal(realpathSync(path), path);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map(row => row.name);
    assert.ok(tables.includes('app_state'), `Unexpected database schema: ${path}`);
    assert.ok(tables.every(name => ['app_state', 'app_state_meta'].includes(name)), `Unexpected tables: ${path}`);
  } finally { db.close(); }
}
for (const path of paths) {
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA secure_delete = ON; BEGIN IMMEDIATE;');
    db.exec('DELETE FROM app_state;');
    if (db.prepare("SELECT name FROM sqlite_master WHERE name = 'app_state_meta'").get()) db.exec('UPDATE app_state_meta SET revision = 0 WHERE id = 1;');
    db.exec('COMMIT; VACUUM; PRAGMA wal_checkpoint(TRUNCATE);');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM app_state').get().count, 0);
    console.log(JSON.stringify({ file: path.slice(data.length + 1), userSnapshots: 0 }));
  } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  finally { db.close(); }
}
const cookie = join(data, 'md-cookie.txt');
if (existsSync(cookie)) { assert.equal(realpathSync(cookie), cookie); writeFileSync(cookie, '', 'utf8'); }
console.log('Old account, session, post, plan, note and backup snapshots cleared; product configuration retained.');
