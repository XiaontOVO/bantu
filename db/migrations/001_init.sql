-- 伴途 P0 PostgreSQL 初始迁移（草案，尚未在真实数据库执行）
-- 命名与 docs/03-数据模型与接口契约.md 对齐：数据库 snake_case，API camelCase。
-- 迁移测试前请先在隔离库执行；本文件不包含演示数据。

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS principals (
  principal_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('anonymous', 'account')),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id uuid NOT NULL REFERENCES principals(principal_id),
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE TABLE IF NOT EXISTS trips (
  trip_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES principals(principal_id),
  data_mode text NOT NULL CHECK (data_mode IN ('online', 'demo')),
  lifecycle text NOT NULL DEFAULT 'draft' CHECK (lifecycle IN ('draft', 'active', 'completed', 'archived')),
  revision bigint NOT NULL DEFAULT 0,
  content_revision bigint NOT NULL DEFAULT 0,
  current_plan_version_id uuid,
  latest_context_id uuid,
  timezone text NOT NULL,
  local_date date NOT NULL,
  city_code text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE IF NOT EXISTS party_members (
  member_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES trips(trip_id) ON DELETE CASCADE,
  display_name text NOT NULL,
  linked_principal_id uuid REFERENCES principals(principal_id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS plan_versions (
  plan_version_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES trips(trip_id) ON DELETE CASCADE,
  revision bigint NOT NULL,
  schema_version integer NOT NULL DEFAULT 1,
  snapshot jsonb NOT NULL,
  reason text NOT NULL,
  action text,
  before_revision bigint,
  after_revision bigint,
  reverses_id uuid,
  mutation_id text,
  created_by uuid REFERENCES principals(principal_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (trip_id, revision)
);

CREATE TABLE IF NOT EXISTS trip_stops (
  stop_id text PRIMARY KEY,
  trip_id uuid NOT NULL REFERENCES trips(trip_id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS execution_events (
  execution_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES trips(trip_id) ON DELETE CASCADE,
  stop_id text NOT NULL,
  type text NOT NULL CHECK (type IN ('depart', 'arrive', 'complete', 'skip', 'abort')),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  user_reported boolean NOT NULL DEFAULT true,
  corrects_event_id uuid REFERENCES execution_events(execution_event_id)
);

CREATE TABLE IF NOT EXISTS spend_events (
  spend_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES trips(trip_id) ON DELETE CASCADE,
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency text NOT NULL DEFAULT 'CNY',
  basis text NOT NULL DEFAULT 'party' CHECK (basis IN ('party', 'per_person')),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  completeness_confirmed boolean NOT NULL DEFAULT false,
  included_charge_ids text[] NOT NULL DEFAULT '{}',
  corrects_event_id uuid REFERENCES spend_events(spend_event_id)
);

CREATE TABLE IF NOT EXISTS walking_events (
  walking_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES trips(trip_id) ON DELETE CASCADE,
  walking_meters numeric NOT NULL CHECK (walking_meters >= 0),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  completeness_confirmed boolean NOT NULL DEFAULT false,
  corrects_event_id uuid REFERENCES walking_events(walking_event_id)
);

CREATE TABLE IF NOT EXISTS trip_shortlist (
  trip_id uuid NOT NULL REFERENCES trips(trip_id) ON DELETE CASCADE,
  place_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trip_id, place_id)
);

CREATE TABLE IF NOT EXISTS mutation_records (
  mutation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES trips(trip_id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES principals(principal_id),
  action text NOT NULL,
  before_revision bigint NOT NULL,
  after_revision bigint NOT NULL,
  reverses_id uuid REFERENCES mutation_records(mutation_id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversations (
  conversation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES trips(trip_id) ON DELETE CASCADE,
  summary text,
  summary_content_revision bigint,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  message_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'system')),
  content_parts jsonb NOT NULL DEFAULT '[]',
  client_message_id text,
  source_refs jsonb NOT NULL DEFAULT '[]',
  redacted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, client_message_id)
);

CREATE TABLE IF NOT EXISTS context_snapshots (
  context_snapshot_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES trips(trip_id) ON DELETE CASCADE,
  data_mode text NOT NULL CHECK (data_mode IN ('online', 'demo')),
  captured_at timestamptz NOT NULL,
  clock_ref text NOT NULL,
  location_ref text,
  event jsonb NOT NULL DEFAULT '{}',
  execution_revision bigint,
  expires_at timestamptz
);

CREATE TABLE IF NOT EXISTS operations (
  operation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES trips(trip_id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES principals(principal_id),
  session_id uuid NOT NULL REFERENCES sessions(session_id),
  kind text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'awaiting_input', 'awaiting_approval', 'cancelled')),
  phase text,
  base_revision bigint,
  expected_revision bigint,
  context_id uuid,
  wall_deadline_at timestamptz,
  input_expires_at timestamptz,
  approval_expires_at timestamptz,
  checkpoint_ref text,
  usage_totals jsonb NOT NULL DEFAULT '{}',
  cancel_requested_at timestamptz,
  result jsonb,
  error jsonb,
  retry_of uuid REFERENCES operations(operation_id),
  lease_token text,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS operations_claim_idx ON operations (status, lease_until);
CREATE INDEX IF NOT EXISTS operations_lease_idx ON operations (lease_until);

CREATE TABLE IF NOT EXISTS proposals (
  proposal_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES trips(trip_id) ON DELETE CASCADE,
  operation_id uuid REFERENCES operations(operation_id),
  generation_key text,
  kind text NOT NULL CHECK (kind IN ('initial', 'replan')),
  base_revision bigint NOT NULL,
  context_id uuid,
  checked_at timestamptz,
  status text NOT NULL CHECK (status IN ('ready', 'applied', 'expired', 'rejected')),
  expires_at timestamptz NOT NULL,
  algorithm_version text,
  prompt_version text,
  evidence_refs jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (trip_id, proposal_id)
);

CREATE TABLE IF NOT EXISTS proposal_candidates (
  candidate_id text PRIMARY KEY,
  proposal_id uuid NOT NULL REFERENCES proposals(proposal_id) ON DELETE CASCADE,
  plan_snapshot jsonb NOT NULL,
  changes jsonb NOT NULL DEFAULT '[]',
  checks jsonb NOT NULL DEFAULT '[]',
  evidence_refs jsonb NOT NULL DEFAULT '[]',
  metrics jsonb NOT NULL DEFAULT '{}',
  applicability text NOT NULL DEFAULT 'needs_verification',
  planned_departure_at timestamptz
);

CREATE TABLE IF NOT EXISTS action_requests (
  action_request_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES trips(trip_id) ON DELETE CASCADE,
  operation_id uuid REFERENCES operations(operation_id),
  execution_operation_id uuid REFERENCES operations(operation_id),
  approval_group_id uuid,
  actor_id uuid NOT NULL REFERENCES principals(principal_id),
  session_id uuid NOT NULL REFERENCES sessions(session_id),
  tool_name text NOT NULL,
  canonical_args jsonb NOT NULL,
  args_digest text NOT NULL,
  base_revision bigint,
  context_id uuid,
  proposal_id uuid REFERENCES proposals(proposal_id),
  candidate_id text,
  display_message_id uuid REFERENCES messages(message_id),
  source_user_message_id uuid REFERENCES messages(message_id),
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'cancelled', 'executed')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS action_requests_group_idx ON action_requests (approval_group_id, status);

CREATE TABLE IF NOT EXISTS action_grants (
  grant_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action_request_id uuid NOT NULL UNIQUE REFERENCES action_requests(action_request_id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES principals(principal_id),
  session_id uuid NOT NULL REFERENCES sessions(session_id),
  confirmation_message_id uuid REFERENCES messages(message_id),
  confirmation_source text,
  status text NOT NULL CHECK (status IN ('active', 'consumed', 'revoked', 'expired')),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tool_executions (
  tool_execution_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id uuid NOT NULL REFERENCES operations(operation_id) ON DELETE CASCADE,
  step_index integer NOT NULL,
  call_id text NOT NULL,
  invocation_key text NOT NULL,
  tool_name text NOT NULL,
  args_digest text NOT NULL,
  action_request_id uuid REFERENCES action_requests(action_request_id),
  grant_id uuid REFERENCES action_grants(grant_id),
  action_key text,
  status text NOT NULL CHECK (status IN ('pending', 'awaiting_approval', 'running', 'succeeded', 'failed', 'cancelled')),
  result_ref jsonb,
  error jsonb,
  mutation_id uuid REFERENCES mutation_records(mutation_id),
  committed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (operation_id, call_id),
  UNIQUE (operation_id, invocation_key)
);

CREATE TABLE IF NOT EXISTS memory_entries (
  memory_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES trips(trip_id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('note', 'recap')),
  entry_version integer NOT NULL DEFAULT 1,
  user_text text NOT NULL,
  source_event_ids text[] NOT NULL DEFAULT '{}',
  source_message_ids uuid[] NOT NULL DEFAULT '{}',
  source_memory_ids uuid[] NOT NULL DEFAULT '{}',
  source_content_revision bigint NOT NULL,
  provenance_refs jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL CHECK (status IN ('draft', 'saved')),
  origin_operation_id uuid REFERENCES operations(operation_id),
  stale_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS memory_entries_origin_operation_uidx
  ON memory_entries (origin_operation_id)
  WHERE origin_operation_id IS NOT NULL AND type = 'recap';

CREATE TABLE IF NOT EXISTS idempotency_records (
  idempotency_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid NOT NULL REFERENCES principals(principal_id),
  action_scope text NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('in_progress', 'completed', 'failed')),
  response_ref jsonb,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (actor_id, action_scope, key)
);

CREATE TABLE IF NOT EXISTS places (
  place_id text PRIMARY KEY,
  provider text NOT NULL,
  provider_place_id text,
  data_mode text NOT NULL CHECK (data_mode IN ('online', 'demo')),
  city_code text,
  name text NOT NULL,
  coordinates jsonb,
  catalog_status text NOT NULL DEFAULT 'published',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_place_id, data_mode)
);

CREATE TABLE IF NOT EXISTS evidence (
  evidence_id text PRIMARY KEY,
  source_type text NOT NULL,
  source_url text,
  observed_at timestamptz,
  retrieved_at timestamptz NOT NULL,
  valid_from timestamptz,
  valid_until timestamptz,
  data_mode text NOT NULL CHECK (data_mode IN ('online', 'demo')),
  verification_status text NOT NULL,
  payload_ref jsonb,
  erased_at timestamptz
);

CREATE TABLE IF NOT EXISTS place_facts (
  fact_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  place_id text NOT NULL REFERENCES places(place_id) ON DELETE CASCADE,
  field_name text NOT NULL,
  value jsonb NOT NULL,
  evidence_id text REFERENCES evidence(evidence_id),
  catalog_release_id text,
  observed_at timestamptz
);

CREATE TABLE IF NOT EXISTS feedback (
  feedback_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES trips(trip_id) ON DELETE CASCADE,
  operation_id uuid REFERENCES operations(operation_id),
  rating integer CHECK (rating BETWEEN 1 AND 5),
  reason_code text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS trips_owner_updated_idx ON trips (owner_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS messages_conversation_created_idx ON messages (conversation_id, created_at, message_id);
CREATE INDEX IF NOT EXISTS execution_events_trip_recorded_idx ON execution_events (trip_id, recorded_at);
CREATE INDEX IF NOT EXISTS proposals_trip_base_status_idx ON proposals (trip_id, base_revision, status);
CREATE INDEX IF NOT EXISTS context_snapshots_expires_idx ON context_snapshots (expires_at);
