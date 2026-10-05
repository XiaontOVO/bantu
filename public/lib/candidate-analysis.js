import { api } from './api.js';
import { state, tripId, tripRevision } from './store.js';
import { render } from './render.js';

export async function analyzeCandidates() {
  if (state.candidateAnalysis?.pending || !state.proposal) return;
  const target = tripId(), proposalId = state.proposal.proposalId, revision = tripRevision();
  const analysis = { proposalId, revision, pending: true, text: '', error: '' };
  state.candidateAnalysis = analysis;
  render();
  try {
    const result = await api(`/api/v1/trips/${target}/proposals/${proposalId}/compare`, {method:'POST', body:JSON.stringify({expectedRevision:revision})});
    if (tripId() === target && state.proposal?.proposalId === proposalId && tripRevision() === revision) analysis.text = result.text;
  } catch (error) { analysis.error = error.message; }
  finally { analysis.pending = false; render(); }
}
