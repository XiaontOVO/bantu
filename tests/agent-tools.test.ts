import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTripService } from '../src/services/trip-service.js';
import { AgentService } from '../src/services/agent-service.js';

test('Agent tool catalog covers all required P0 tool bindings except optional weather', () => {
  const service = new InMemoryTripService();
  const agents = new AgentService(service);
  const names = agents.listToolDefinitions().map((tool) => tool.name);
  for (const required of [
    'trip.read',
    'places.search',
    'places.detail',
    'routes.estimate',
    'plan.propose',
    'plan.apply',
    'plan.undo',
    'preferences.update',
    'progress.record',
    'shortlist.add',
    'shortlist.remove',
    'memory.create',
  ]) {
    assert.ok(names.includes(required), `missing tool ${required}`);
  }
  assert.equal(names.includes('weather.read'), false);
  const planApply = agents
    .listToolDefinitions(['plan.apply'])
    .find((tool) => tool.name === 'plan.apply');
  assert.ok(planApply);
  assert.ok(planApply?.inputSchema);

  const weatherAgents = new AgentService(service, {
    weatherProvider: {
      providerName: 'fake_weather',
      read: async () => ({
        available: true,
        summary: '样例天气',
        observedAt: '2026-09-20T12:00:00+08:00',
      }),
    },
  });
  assert.ok(weatherAgents.listToolDefinitions().some((tool) => tool.name === 'weather.read'));
});
