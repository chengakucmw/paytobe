-- AgentFood is an ordinary reference merchant. No Agent private key, webhook
-- secret, shared bearer token, Connection, or Payment Request is seeded here.
-- Credential proof and Webhook activation must use the public control-plane
-- contracts so the corresponding secrets never enter source control.

CREATE TABLE IF NOT EXISTS legacy_resource_mappings (
  mapping_id TEXT PRIMARY KEY,
  source_system TEXT NOT NULL,
  source_resource_type TEXT NOT NULL,
  source_resource_id TEXT NOT NULL,
  canonical_resource_type TEXT NOT NULL,
  canonical_resource_id TEXT NOT NULL,
  migration_state TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (source_system, source_resource_type, source_resource_id)
);
CREATE INDEX IF NOT EXISTS legacy_resource_mappings_target_idx
  ON legacy_resource_mappings(canonical_resource_type, canonical_resource_id);

UPDATE merchants SET display_name = 'AgentFood', status = 'active',
  verification_state = 'verified', version = version + 1,
  updated_at = '2026-08-02T00:00:00.000Z'
  WHERE merchant_id = 'agentfood' AND verification_state <> 'verified';

UPDATE agents SET name = 'AgentFood Reference Agent', runtime = 'node',
  environment = 'testnet',
  source_domain = 'agentfood-Paytobe-demo.chengakucmw.chatgpt.site',
  allowed_scopes_json = '["payment.requests.create","payment.requests.read","transaction_contexts.create","transaction_contexts.read"]',
  status = 'active', version = version + 1,
  updated_at = '2026-08-02T00:00:00.000Z'
  WHERE merchant_id = 'agentfood' AND agent_id = 'agentfood-testnet'
    AND (name <> 'AgentFood Reference Agent'
      OR runtime <> 'node'
      OR environment <> 'testnet'
      OR allowed_scopes_json <> '["payment.requests.create","payment.requests.read","transaction_contexts.create","transaction_contexts.read"]'
      OR status <> 'active');

INSERT OR IGNORE INTO recipients (
  recipient_id, merchant_id, name, status, active_version_id, version, created_at, updated_at
) VALUES (
  'agentfood-reference-recipient', 'agentfood', 'AgentFood Reference Recipient', 'active',
  'agentfood-reference-recipient-v1', 1, '2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z'
);

INSERT OR IGNORE INTO recipient_versions (
  recipient_version_id, merchant_id, recipient_id, network, asset, address, memo,
  verification_state, effective_at, created_at
) VALUES (
  'agentfood-reference-recipient-v1', 'agentfood', 'agentfood-reference-recipient',
  'stellar_testnet', 'XLM', 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', NULL,
  'active', '2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z'
);

INSERT OR IGNORE INTO legacy_resource_mappings VALUES
  ('map_agentfood_tenant', 'agentfood_legacy', 'tenant', 'agentfood', 'merchant', 'agentfood',
   'migrated', '{}', '2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z'),
  ('map_agentfood_client', 'agentfood_legacy', 'agent_client', 'agentfood-testnet', 'agent', 'agentfood-testnet',
   'migrated', '{}', '2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z'),
  ('map_agentfood_recipient', 'agentfood_legacy', 'fixed_recipient', 'stellar-testnet-demo', 'recipient', 'agentfood-reference-recipient',
   'migrated', '{"recipient_version_id":"agentfood-reference-recipient-v1"}', '2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z'),
  ('map_agentfood_token', 'agentfood_legacy', 'shared_token_auth', 'builtin:agentfood-testnet-web-integration', 'agent_credential', 'agentfood-reference-key',
   'provisioning_required', '{"public_contract":"POST /v1/agents/{agent_id}/credentials","shared_token_fallback":false}', '2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z'),
  ('map_agentfood_webhook', 'agentfood_legacy', 'callback', 'agentfood-payment-status', 'webhook_endpoint', 'agentfood-payment-status',
   'provisioning_required', '{"public_contract":"POST /v1/webhook-endpoints"}', '2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z');
