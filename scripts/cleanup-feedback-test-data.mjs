// Targeted, offline maintenance. Defaults to read-only; only the audited test identity is accepted.
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
const apply=process.argv.includes('--apply'),file=resolve('data/bantu-state.sqlite');
if(apply&&existsSync('data/bantu-server.pid')){
 const record=JSON.parse(readFileSync('data/bantu-server.pid','utf8').replace(/^\uFEFF/,''));
 try{process.kill(record.processId,0);throw new Error('Stop the verified project server before offline cleanup.')}catch(error){if(error.code!=='ESRCH')throw error}
}
const db=new DatabaseSync(file,{readOnly:!apply});
const prefix='bantu-trip-service',username='uitest0929',expectedActor='principal_4a304db0ea04417d';
try{
 const rows=db.prepare('SELECT key,value FROM app_state').all(),snapshots=new Map(rows.map(r=>[r.key,JSON.parse(r.value)]));
 const accounts=snapshots.get(prefix+':accounts'),account=accounts.find(a=>a.username===username);
 if(!account){console.log(JSON.stringify({alreadyClean:true}));process.exit(0)}
 assert.equal(account.actorId,expectedActor,'Only the exact identity audited in the feedback may be removed.');
 const actor=account.actorId,community=snapshots.get(prefix+':community'),base=snapshots.get(prefix);
 const ownPostIds=new Set(community.posts.filter(p=>p.authorId===actor).map(p=>p.id));
 const ownTripIds=new Set(base.trips.filter(t=>t.ownerId===actor).map(t=>t.tripId));
 const ownSessionIds=new Set(base.sessions.filter(s=>s.principalId===actor).map(s=>s.sessionId));
 const identifiers=new Set([actor,...ownPostIds,...ownTripIds,...ownSessionIds]);
 const owned=v=>v&&typeof v==='object'&&!Array.isArray(v)&&['actorId','authorId','ownerId','principalId'].some(k=>v[k]===actor);
 const matchesKey=key=>identifiers.has(key)||key===`agent-general-${actor}`||key.startsWith(actor+':');
 const counts={accounts:1,posts:ownPostIds.size,comments:community.posts.flatMap(p=>p.comments||[]).filter(c=>c.actorId===actor).length,
  shares:community.planShares.filter(p=>p.authorId===actor).length,plans:snapshots.get(prefix+':plan-library').filter(owned).length,
  notes:(snapshots.get(prefix+':personal-memories')[actor]||[]).length};
 // Follow normal comment deletion semantics: retain replies by other people with a tombstone parent.
 community.posts=community.posts.filter(p=>!ownPostIds.has(p.id));
 for(const post of community.posts){
  const parents=new Set(post.comments.map(c=>c.parentCommentId).filter(Boolean));
  post.comments=post.comments.flatMap(c=>c.actorId!==actor?[c]:parents.has(c.id)?[{...c,actorId:'deleted-feedback-test-user',nickname:'已删除',text:'',deleted:true}]:[]);
 }
 function clean(v){
  if(Array.isArray(v))return v.flatMap(item=>{
   if(typeof item==='string'&&identifiers.has(item))return [];
   if(owned(item))return [];
   if(Array.isArray(item)&&typeof item[0]==='string'&&(matchesKey(item[0])||owned(item[1])))return [];
   if(item&&typeof item==='object'&&['postId','tripId','sessionId'].some(k=>identifiers.has(item[k])))return [];
   return [clean(item)];
  });
  if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).filter(([k,x])=>!matchesKey(k)&&!owned(x)).map(([k,x])=>[k,clean(x)]));
  return v;
 }
 const entries=[];
 for(const [key,value] of snapshots){
  // Inner serialized ledgers use the same actor ownership; do not touch opaque model settings.
  if(key===prefix){for(const ledger of ['authorization','idempotency'])if(typeof value[ledger]==='string')value[ledger]=JSON.stringify(clean(JSON.parse(value[ledger])))}
  const after=JSON.stringify(clean(value));
  assert.ok(!after.includes(actor),`Dangling target identity in ${key}`);
  if(after!==rows.find(r=>r.key===key).value)entries.push([key,after]);
 }
 const nextAccounts=JSON.parse(entries.find(([k])=>k===prefix+':accounts')?.[1]||rows.find(r=>r.key===prefix+':accounts').value);
 assert.deepEqual(nextAccounts,accounts.filter(a=>a.actorId!==actor),'Every other account must remain byte-equivalent.');
 const beforePlans=JSON.parse(rows.find(r=>r.key===prefix+':plan-library').value);
 assert.deepEqual(JSON.parse(entries.find(([k])=>k===prefix+':plan-library')[1]),beforePlans.filter(p=>!owned(p)),'Other users plans must remain unchanged.');
 const beforeNotes=JSON.parse(rows.find(r=>r.key===prefix+':personal-memories').value);
 assert.deepEqual(JSON.parse(entries.find(([k])=>k===prefix+':personal-memories')[1]),Object.fromEntries(Object.entries(beforeNotes).filter(([k])=>k!==actor)),'Other users notes must remain unchanged.');
 const nextCommunity=JSON.parse(entries.find(([k])=>k===prefix+':community')[1]);
 const originals=JSON.parse(rows.find(r=>r.key===prefix+':community').value);
 for(const p of nextCommunity.posts){const original=originals.posts.find(o=>o.id===p.id);assert.equal(p.text,original.text);assert.deepEqual(p.images,original.images);for(const c of original.comments.filter(c=>c.actorId!==actor))assert.deepEqual(p.comments.find(x=>x.id===c.id),c,'Other authors comments must stay unchanged.')}
 const report={applied:apply,username,counts,changedKeys:entries.map(([k])=>k)};
 if(apply){
  const folder=resolve('data/backups');mkdirSync(folder,{recursive:true});
  const backup=join(folder,'before-feedback-test-cleanup-'+new Date().toISOString().replace(/[:.]/g,'-')+'.sqlite');
  db.prepare('VACUUM INTO ?').run(backup);
  const copy=new DatabaseSync(backup,{readOnly:true});try{assert.equal(copy.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.deepEqual(copy.prepare('SELECT key,value FROM app_state ORDER BY key').all(),db.prepare('SELECT key,value FROM app_state ORDER BY key').all())}finally{copy.close()}
  db.exec('BEGIN IMMEDIATE');try{const update=db.prepare('UPDATE app_state SET value=?,updated_at=? WHERE key=?');for(const [k,v] of entries)update.run(v,new Date().toISOString(),k);assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');db.exec('COMMIT')}catch(error){db.exec('ROLLBACK');throw error}
  report.backup=backup;writeFileSync('tmp/feedback-test-cleanup-proof.json',JSON.stringify(report,null,2));
 }
 console.log(JSON.stringify(report));
}finally{db.close()}
