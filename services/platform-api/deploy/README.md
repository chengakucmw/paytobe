# VelarumPay Platform API Deployment

> **Last modified**
> - **Taipei Time:** 2026-08-03 18:06:25 Asia/Taipei (UTC+08:00)
> - **UTC:** 2026-08-03 10:06:25 UTC

This folder contains the minimal managed runtime assets for the Platform API.

## Required Production Environment

Use `/etc/velarumpay/platform-api.env`, Docker Compose `../.env`, or equivalent managed secret injection.

```bash
NODE_ENV=production
RUNTIME_ENV=production
PUBLIC_BASE_URL=https://api.velarumai.com
OFFICIAL_TESTNET_ONLY=true
CORS_ALLOWED_ORIGINS=https://velarumai.com,https://www.velarumai.com,https://portal.velarumai.com,https://agentfood.velarumai.com
CORS_ALLOW_CREDENTIALS=true
OPENCLAW_DEVICE_SECRET=replace-with-32-byte-random-secret
ALLOW_UNSIGNED_OPENCLAW=false
RELAY_STORE_DRIVER=sqlite
RELAY_STORE_PATH=/var/lib/velarumpay/relay-store.sqlite
RELAY_STORE_LEGACY_JSON=/var/lib/velarumpay/relay-store.json
METRICS_TOKEN=replace-with-metrics-token
AUDIT_LOG_READ_TOKEN=replace-with-audit-token
STELLAR_PUBLIC_ENABLED=false
STELLAR_TESTNET_HORIZON_URL=https://horizon-testnet.stellar.org
TRANSACTIONAL_EMAIL_PROVIDER=cloudflare
CLOUDFLARE_EMAIL_ACCOUNT_ID=replace-with-account-id
CLOUDFLARE_EMAIL_API_TOKEN=replace-with-email-sending-token
TRANSACTIONAL_EMAIL_FROM=security@velarumai.com
MERCHANT_PORTAL_PUBLIC_URL=https://portal.velarumai.com
```

Run the preflight before starting production:

```bash
cd /opt/velarumpay/VelarumPayCode/services/platform-api
npm run check:runtime-config
```

## Docker Compose

Build and start from the repository root:

```bash
docker compose -f services/platform-api/deploy/docker-compose.yml up -d --build
docker compose -f services/platform-api/deploy/docker-compose.yml ps
curl -fsS http://127.0.0.1:8787/health
```

The container uses `/var/lib/velarumpay/relay-store.sqlite` and named volumes for data and backups.

## systemd

Install Node.js 24, create a `velarumpay` user, copy the repository to `/opt/velarumpay/VelarumPayCode`, and create writable data directories:

```bash
sudo install -d -o velarumpay -g velarumpay /var/lib/velarumpay /var/backups/velarumpay /etc/velarumpay
sudo cp services/platform-api/deploy/systemd/velarumpay-platform-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now velarumpay-platform-api
sudo systemctl status velarumpay-platform-api
```

## Backup And Rollback

Create a SQLite backup before every deploy:

```bash
cd /opt/velarumpay/VelarumPayCode/services/platform-api
npm run backup -- /var/backups/velarumpay/relay-store-before-deploy.sqlite
```

Rollback code by redeploying the previous image or git ref. If store rollback is required, stop the service first, copy the selected backup over `RELAY_STORE_PATH`, preserve ownership, and restart:

```bash
sudo systemctl stop velarumpay-platform-api
sudo install -o velarumpay -g velarumpay -m 0600 /var/backups/velarumpay/relay-store-before-deploy.sqlite /var/lib/velarumpay/relay-store.sqlite
sudo systemctl start velarumpay-platform-api
curl -fsS http://127.0.0.1:8787/health
```
