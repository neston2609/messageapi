# Genesys Open Messaging Bridge

Single-process Node.js middleware for Genesys Cloud Open Messaging and external digital channels. It uses JSON/JSONL files, an admin UI, and one HTTP port. No database or container runtime is required.

```text
Channel webhooks / pollers -> Channel adapters -> Core router -> Genesys Open Messaging API
                                               |                 |
                                         File store + queue   OAuth token cache
Genesys outbound webhook -> Signature check -> Durable queue -> Channel adapters
```

## Run

Requires Node.js 20+ and public HTTPS for external webhooks. Run:

```sh
npm install
npm run build
npm start
```

Open `http://localhost:3000`. On first startup, the app creates `.env` with a random encryption key and `data/config/first-run-admin.txt` with a one-time admin password. Sign in and change the password in Settings, which removes that file. Back up `.env` together with `data/`; without the key, encrypted credentials cannot be recovered.

Disabled example records are in `samples/`. Enter real values through the UI; do not copy plaintext sample credentials into runtime JSON files.

`npm run dev`, `npm run lint`, and `npm test` are available. Production files are under `data/config`, `data/sessions`, `data/queue`, `data/dlq`, `data/media`, and `data/logs`. Admin APIs read configuration on each request, so channel and credential edits apply without process restart. `PORT` and `HOST` are process settings and require restart to change the listener.

## Genesys setup

1. Confirm the organization has a supported Genesys Cloud Digital license and **Messaging > Integration > All** permission. [Genesys setup guide](https://help.genesys.cloud/?p=242772).
2. Create an OAuth client with the Client Credentials grant and a role permitted to create inbound conversations/messages. Record the client ID and secret. The precise role permissions vary by organization; use **Test Credentials** in this UI, then send an actual test message before production traffic.
3. In Genesys Admin, open **Message > Platforms > Platform Integrations**, create an **Open Messaging** integration, and record its integration ID.
4. In this UI, add the Genesys region, OAuth credentials, integration ID, and a random outbound webhook signature secret. Leave signature validation enabled.
5. Copy the displayed `https://<public-host>/webhooks/genesys/<integrationId>` URL into **Outbound Notification Webhook URL** in Genesys. Genesys requires HTTPS on port 443 with no custom port. Enter the same signature secret in Genesys. [Genesys setup guide](https://help.genesys.cloud/?p=242772).
6. Add a channel, bind it to the Genesys integration, enter platform credentials, copy its inbound webhook URL, and enable the channel after its platform test passes.

The deployed Windows origin uses Cloudflare Tunnel and nginx; see [docs/DEPLOY.md](docs/DEPLOY.md). A direct Linux TLS/nginx example is in `deploy/messageapi.nginx.conf`.

## Channel support and limits

| Channel | Inbound | Outbound | Notes |
| --- | --- | --- | --- |
| LINE OA | Signed webhook | Push API | Media re-hosting, profile lookup; reply-token optimization is pending. |
| Facebook Messenger | Signed webhook | Graph API text | Requires approved page permissions; attachment send and window policy rely on Meta response. |
| Instagram DM | Signed webhook | Graph API text | Requires approved Instagram messaging permissions. |
| WhatsApp Cloud API | Signed webhook | Cloud API text | Tenant templates and media outbound are not implemented. |
| Telegram | Secret-token webhook | Bot API text | Inbound media re-hosted. |
| YouTube | OAuth or API-key comment polling | OAuth comment replies | OAuth mode is two-way and renews access automatically. API-key mode is inbound/read-only. Service accounts work only for eligible Content Owner/CMS use cases. |
| X DM | API polling | DM API text | Requires X DM read/write access and user token. |
| WeChat Official Account | Signed plaintext XML webhook | Customer-service text | Encrypted callback mode is not supported. |
| TikTok | Signed developer webhook | Configured tenant endpoint | DM API access and endpoint are tenant-specific; no universal DM endpoint is assumed. |
| Pantip.com | Signed certified/partner webhook | Configured certified endpoint | Requires an approved Pantip Certified Developer or partner contract; the bridge does not scrape Pantip or assume an undocumented public API. |
| Generic REST | HMAC webhook | Configured HTTPS endpoint | JSON text contract; useful for custom platforms. |

Channel capabilities in the UI reflect supported content. Features that depend on channel approval, OAuth scopes, or credentials cannot be verified from a clean installation. Keep channels disabled until their end-to-end platform tests pass.

## Security and operation

- Credentials are encrypted at rest with AES-256-GCM. Admin login uses Argon2, an HttpOnly signed cookie, CSRF header, and login rate limits. Webhooks are exempt from admin auth but require platform signatures.
- Settings can export/import encrypted configuration and rotate the app-managed encryption key. Preserve a fresh `.env` backup after rotation; imports need the same key that encrypted the export.
- Media is downloaded to `data/media` and served by expiring signed `/media/:token` URLs. The public base URL must be HTTPS and reachable by Genesys.
- The outbound queue is journaled in JSONL, retries with exponential backoff, and moves exhausted items to the DLQ. Inbound event IDs are persisted for replay deduplication.
- `GET /health` is liveness. `GET /health/detailed` exposes basic counts. Review `data/logs` and the admin Message Explorer when troubleshooting.
- The service currently has no verified production channel credentials. A healthy HTTP endpoint does not mean Genesys or channel delivery has been activated.

See [docs/API.md](docs/API.md) and [docs/ADD_NEW_CHANNEL.md](docs/ADD_NEW_CHANNEL.md).

For step-by-step Genesys and platform configuration, see [docs/USER_MANUAL.md](docs/USER_MANUAL.md).
