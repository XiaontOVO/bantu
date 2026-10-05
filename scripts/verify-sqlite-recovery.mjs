// Read-only source backup; restoration and server boot use independent files.
import assert from 'node:assert/strict';
import {DatabaseSync,backup} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {SqliteStateStore} from '../dist/src/persistence/state-store.js';
import {createHttpServer} from '../dist/src/server/http-server.js';

const sourcePath=resolve(process.argv[2]||'data/bantu-state.sqlite');
const backupRoot=resolve('data/backups');mkdirSync(backupRoot,{recursive:true});
const output=mkdtempSync(join(backupRoot,'sqlite-recovery-'));
const backupPath=join(output,'backup.sqlite'),restoredPath=join(output,'restored.sqlite');
const digest=db=>createHash('sha256').update(JSON.stringify(db.prepare('SELECT key, value FROM app_state ORDER BY key').all())).digest('hex');
const source=new DatabaseSync(sourcePath,{readOnly:true});let server,store;
try{
 const rows=source.prepare('SELECT key, value FROM app_state ORDER BY key').all();
 const expected=digest(source);
 await backup(source,backupPath);
 const snapshot=new DatabaseSync(backupPath,{readOnly:true});
 try{
  assert.equal(Object.values(snapshot.prepare('PRAGMA integrity_check').get())[0],'ok');
  assert.equal(digest(snapshot),expected,'backup contents');
  await backup(snapshot,restoredPath);
 }finally{snapshot.close()}
 store=new SqliteStateStore(restoredPath);
 for(const row of rows)assert.equal(store.get(row.key),row.value,'restored collection');
 server=createHttpServer({seedDemo:false,stateStore:store});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const response=await fetch(`http://127.0.0.1:${server.address().port}/api/v1/health`);
 assert.equal(response.status,200);
 assert.equal((await response.json()).data.status,'ok');
 assert.equal(digest(source),expected,'source unchanged during verification');
 const proof={collections:rows.length,integrityCheck:'ok',backupMatches:true,restoredValuesMatch:true,restoredServerHealth:200,sourceUnchanged:true,sourcePath,output};
 mkdirSync('tmp',{recursive:true});writeFileSync('tmp/mobile-final-sqlite-recovery-proof.json',JSON.stringify(proof,null,2));
 console.log(JSON.stringify(proof));
}finally{
 if(server){server.closeAllConnections();await new Promise(r=>server.close(r))}
 store?.close();source.close();
}
