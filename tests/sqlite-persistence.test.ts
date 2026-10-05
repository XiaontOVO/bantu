import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpServer } from '../src/server/http-server.js';
import { SqliteStateStore } from '../src/persistence/state-store.js';

async function listen(server: ReturnType<typeof createHttpServer>): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: ReturnType<typeof createHttpServer>): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test('SQLite state store restores trips and cookie sessions after a process restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bantu-state-'));
  const file = join(directory, 'state.sqlite');
  const stateKey = 'http-restart-test';
  let firstServer: ReturnType<typeof createHttpServer> | undefined;
  let secondServer: ReturnType<typeof createHttpServer> | undefined;
  try {
    const firstStore = new SqliteStateStore(file);
    firstServer = createHttpServer({
      seedDemo: false,
      stateStore: firstStore,
      stateKey,
      now: () => '2026-09-20T13:00:00+08:00',
    });
    const firstBase = await listen(firstServer);

    const guest = await fetch(`${firstBase}/api/v1/session/guest`, { method: 'POST' });
    const cookie = guest.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie);

    const created = await fetch(`${firstBase}/api/v1/trips`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookie! },
      body: JSON.stringify({ cityCode: '330100', localDate: '2026-09-20', dataMode: 'demo' }),
    });
    assert.equal(created.status, 200);
    const createdBody = (await created.json()) as { data: { trip: { tripId: string } } };
    await close(firstServer);
    firstStore.close();
    firstServer = undefined;

    const secondStore = new SqliteStateStore(file);
    secondServer = createHttpServer({
      seedDemo: false,
      stateStore: secondStore,
      stateKey,
      now: () => '2026-09-20T13:04:00+08:00',
    });
    const secondBase = await listen(secondServer);

    const me = await fetch(`${secondBase}/api/v1/me`, { headers: { cookie: cookie! } });
    assert.equal(me.status, 200);
    const trips = await fetch(`${secondBase}/api/v1/trips`, { headers: { cookie: cookie! } });
    assert.equal(trips.status, 200);
    const tripsBody = (await trips.json()) as { data: Array<{ tripId: string }> };
    assert.equal(tripsBody.data.length, 1);
    assert.equal(tripsBody.data[0].tripId, createdBody.data.trip.tripId);
    await close(secondServer);
    secondStore.close();
    secondServer = undefined;
  } finally {
    if (firstServer) await close(firstServer);
    if (secondServer) await close(secondServer);
    try {
      await rm(directory, { recursive: true, force: true });
    } catch {
      // Windows 上仍可能有未关闭的 SQLite 句柄。
    }
  }
});

test('read-only API requests do not rewrite SQLite or poison a stale reader instance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bantu-read-state-'));
  const file = join(directory, 'state.sqlite');
  const stateKey = 'read-request-test';
  let seedServer: ReturnType<typeof createHttpServer> | undefined;
  let firstServer: ReturnType<typeof createHttpServer> | undefined;
  let secondServer: ReturnType<typeof createHttpServer> | undefined;
  let seedStore: SqliteStateStore | undefined;
  let firstStore: SqliteStateStore | undefined;
  let secondStore: SqliteStateStore | undefined;
  try {
    seedStore = new SqliteStateStore(file);
    seedServer = createHttpServer({ seedDemo: false, stateStore: seedStore, stateKey, now: () => '2026-09-20T13:00:00+08:00' });
    const seedBase = await listen(seedServer);
    const guest = await fetch(`${seedBase}/api/v1/session/guest`, { method: 'POST' });
    const cookie = guest.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie);
    await close(seedServer);
    seedServer = undefined;
    seedStore.close();
    seedStore = undefined;

    firstStore = new SqliteStateStore(file);
    secondStore = new SqliteStateStore(file);
    firstServer = createHttpServer({ seedDemo: false, stateStore: firstStore, stateKey, now: () => '2026-09-20T13:00:00+08:00' });
    secondServer = createHttpServer({ seedDemo: false, stateStore: secondStore, stateKey, now: () => '2026-09-20T13:00:00+08:00' });
    const firstBase = await listen(firstServer);
    const secondBase = await listen(secondServer);

    const readRevision = secondStore.getRevision();
    assert.equal((await fetch(`${secondBase}/api/v1/me`, { headers: { cookie: cookie! } })).status, 200);
    assert.equal(secondStore.getRevision(), readRevision, 'a read must not rewrite all state rows');

    const created = await fetch(`${firstBase}/api/v1/trips`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookie! },
      body: JSON.stringify({ cityCode: '330100', localDate: '2026-09-20', dataMode: 'demo' }),
    });
    assert.equal(created.status, 200);
    const staleRead = await fetch(`${secondBase}/api/v1/me`, { headers: { cookie: cookie! } });
    assert.equal(staleRead.status, 200, 'a stale instance can serve a read without entering persistence failure');

    const staleWrite = await fetch(`${secondBase}/api/v1/trips`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookie! },
      body: JSON.stringify({ cityCode: '330100', localDate: '2026-09-20', dataMode: 'demo' }),
    });
    assert.equal(staleWrite.status, 409, 'a stale instance must still reject its conflicting write');
    const unavailable = await fetch(`${secondBase}/api/v1/me`, { headers: { cookie: cookie! } });
    assert.equal(unavailable.status, 503, 'after a genuine write conflict, the unsafe instance stays paused');
  } finally {
    if (seedServer) await close(seedServer);
    if (firstServer) await close(firstServer);
    if (secondServer) await close(secondServer);
    seedStore?.close();
    firstStore?.close();
    secondStore?.close();
    try { await rm(directory, { recursive: true, force: true }); } catch {}
  }
});

test('SQLite state store restores an awaiting-approval agent checkpoint and resumes once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bantu-agent-state-'));
  const file = join(directory, 'state.sqlite');
  const stateKey = 'agent-restart-test';
  let firstServer: ReturnType<typeof createHttpServer> | undefined;
  let secondServer: ReturnType<typeof createHttpServer> | undefined;
  try {
    const firstStore = new SqliteStateStore(file);
    firstServer = createHttpServer({
      seedDemo: false,
      stateStore: firstStore,
      stateKey,
      now: () => '2026-09-20T13:00:00+08:00',
    });
    const firstBase = await listen(firstServer);
    const guest = await fetch(`${firstBase}/api/v1/session/guest`, { method: 'POST' });
    const cookie = guest.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie);
    const created = await fetch(`${firstBase}/api/v1/trips`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookie! },
      body: JSON.stringify({ cityCode: '330100', localDate: '2026-09-20', dataMode: 'demo' }),
    });
    const createdBody = (await created.json()) as { data: { trip: { tripId: string } } };
    const tripId = createdBody.data.trip.tripId;

    const planned = await fetch(`${firstBase}/api/v1/trips/${tripId}/initial-plans`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookie! },
      body: JSON.stringify({ baseRevision: 0 }),
    });
    const plannedBody = (await planned.json()) as {
      data: { proposal: { proposalId: string; candidates: Array<{ candidateId: string }> } };
    };
    const proposalId = plannedBody.data.proposal.proposalId;
    const candidateId = plannedBody.data.proposal.candidates[0].candidateId;

    const pending = await fetch(
      `${firstBase}/api/v1/trips/${tripId}/proposals/${proposalId}/apply`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: cookie! },
        body: JSON.stringify({ candidateId, expectedRevision: 0 }),
      },
    );
    assert.equal(pending.status, 403);
    const pendingBody = (await pending.json()) as {
      error: { details: { operationId: string; actionRequestId: string } };
    };
    const operationId = pendingBody.error.details.operationId;
    const actionRequestId = pendingBody.error.details.actionRequestId;
    assert.ok(operationId);
    assert.ok(actionRequestId);

    await close(firstServer);
    firstStore.close();
    firstServer = undefined;

    const secondStore = new SqliteStateStore(file);
    secondServer = createHttpServer({
      seedDemo: false,
      stateStore: secondStore,
      stateKey,
      now: () => '2026-09-20T13:04:00+08:00',
    });
    const secondBase = await listen(secondServer);

    const operation = await fetch(`${secondBase}/api/v1/operations/${operationId}`, {
      headers: { cookie: cookie! },
    });
    assert.equal(operation.status, 200);
    const operationBody = (await operation.json()) as { data: { status: string } };
    assert.equal(operationBody.data.status, 'awaiting_approval');

    const approved = await fetch(
      `${secondBase}/api/v1/trips/${tripId}/action-requests/${actionRequestId}/decisions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: cookie! },
        body: JSON.stringify({ decision: 'approve', operationId }),
      },
    );
    assert.equal(approved.status, 200);
    const approvedBody = (await approved.json()) as {
      data: { operation?: { status: string; result?: { kind?: string } } };
    };
    assert.equal(approvedBody.data.operation?.status, 'succeeded');
    assert.equal(approvedBody.data.operation?.result?.kind, 'agent_result');

    const trip = await fetch(`${secondBase}/api/v1/trips/${tripId}`, {
      headers: { cookie: cookie! },
    });
    const tripBody = (await trip.json()) as { data: { trip: { revision: number } } };
    assert.equal(tripBody.data.trip.revision, 1);
    await close(secondServer);
    secondStore.close();
    secondServer = undefined;
  } finally {
    if (firstServer) await close(firstServer);
    if (secondServer) await close(secondServer);
    try {
      await rm(directory, { recursive: true, force: true });
    } catch {
      // Windows 上仍可能有未关闭的 SQLite 句柄。
    }
  }
});



