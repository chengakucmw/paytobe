INSERT OR IGNORE INTO tenants (tenant_id, display_name, status, created_at, updated_at)
VALUES ('agentfood', 'AgentFood', 'active', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');

INSERT OR IGNORE INTO agent_clients (
  client_id, tenant_id, display_name, runtime, source_domain, token_hash,
  status, created_at, updated_at
) VALUES (
  'agentfood-testnet',
  'agentfood',
  'AgentFood',
  'velarumpay-platform',
  'agentfood-velarumpay-demo.chengakucmw.chatgpt.site',
  'builtin:agentfood-testnet-web-integration',
  'active',
  '2026-08-01T00:00:00.000Z',
  '2026-08-01T00:00:00.000Z'
);
