import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

test('result card stays identifiable across rendering without repeatedly changing scroll position', async () => {
  const load = (path: string) => import(pathToFileURL(join(process.cwd(), path)).href);
  const { state } = await load('public/lib/store.js');
  const { focusAgentResultCard } = await load('public/lib/agent-result-focus.js');
  const previous = { document: globalThis.document, view: state.currentView, target: state.agentResultTarget };
  let scrolls = 0, focuses = 0, scrollBlock = '';
  let dataset:Record<string,string>={plan:'expected'};
  const card = { tabIndex: 0, focus: () => focuses++, scrollIntoView: (options:any) => {scrolls++;scrollBlock=options.block;} };
  globalThis.document = { querySelectorAll: () => [{ dataset, closest: () => card }] } as unknown as Document;
  try {
    state.currentView = 'plan';
    state.agentResultTarget = { view: 'plan', id: 'expected', scrolled: false };
    focusAgentResultCard();
    assert.equal(card.tabIndex, -1);
    assert.equal(scrolls, 1);
    card.tabIndex = 0;
    focusAgentResultCard();
    assert.equal(card.tabIndex, -1);
    assert.equal(scrolls, 1);
    assert.equal(focuses, 1);
    state.currentView = 'memories';
    focusAgentResultCard();
    assert.equal(scrolls, 1);
    dataset={memory:'expected'};
    state.agentResultTarget={view:'memories',id:'expected',scrolled:false};
    focusAgentResultCard();
    assert.equal(scrollBlock,'start','a long private record must start with its heading');
    assert.equal(scrolls,2);
    focusAgentResultCard();assert.equal(scrolls,2);
  } finally {
    globalThis.document = previous.document;
    state.currentView = previous.view;
    state.agentResultTarget = previous.target;
  }
});
