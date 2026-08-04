-- Remove the retired AgentFood shared-token compatibility identity. Historical
-- payment, Connect, Merchant, Agent, and Recipient records remain intact.

UPDATE agent_clients
SET status = 'revoked',
    token_hash = 'removed:agentfood-shared-token-auth',
    updated_at = '2026-08-04T13:12:00.000Z'
WHERE client_id = 'agentfood-testnet'
  AND token_hash = 'builtin:agentfood-testnet-web-integration';

DELETE FROM legacy_resource_mappings
WHERE source_system = 'agentfood_legacy'
  AND source_resource_type = 'shared_token_auth';
