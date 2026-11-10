# HTTP API

All paths share the configured server port. Admin requests require the signed `bridge_session` HttpOnly cookie. Mutations also require `X-CSRF-Token`, returned by login or session status. Responses are JSON unless noted.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Liveness: `{"status":"ok"}` |
| GET | `/health/detailed` | Uptime and configuration counts |
| POST | `/api/auth/login` | `{"username":"admin","password":"..."}`; returns `{"ok":true,"csrf":"..."}` |
| GET | `/api/auth/session` | Refresh CSRF token for an active cookie |
| POST | `/api/auth/logout` | Clear browser cookie |
| GET | `/api/admin/overview` | Dashboard counters and capabilities |
| GET/PUT/DELETE | `/api/admin/genesys`, `/api/admin/genesys/:id` | List, save, delete integrations |
| POST | `/api/admin/genesys/:id/test` | Fetch OAuth token |
| GET/PUT/DELETE | `/api/admin/channels`, `/api/admin/channels/:id` | List, save, delete channels |
| POST | `/api/admin/channels/:id/test` | Adapter configuration health |
| GET | `/api/admin/messages` | Recent JSONL message records |
| GET/DELETE | `/api/admin/sessions`, `/api/admin/sessions/:channelId/:userId` | Inspect/end sessions |
| GET | `/api/admin/queue` | Pending items and dead letters |
| POST | `/api/admin/queue/:id/retry`, `/api/admin/queue/retry-all`, `/api/admin/dlq/:id/retry` | Retry operations |
| DELETE | `/api/admin/queue`, `/api/admin/dlq` | Purge operations |
| GET/PUT | `/api/admin/settings` | Global settings |
| POST | `/api/admin/password` | `{"current":"...","next":"..."}` |
| GET/POST | `/api/admin/export`, `/api/admin/import` | Versioned JSON backup/restore for settings, channels, routing, integrations, and encrypted credentials |
| POST | `/api/admin/encryption/rotate` | Re-authenticate with `{"password":"..."}` and rotate the app-managed key |
| POST | `/api/admin/reveal` | Re-authenticate and reveal one configured credential set |
| GET/POST | `/webhooks/channel/:channelId` | Platform challenge/inbound webhook |
| POST | `/webhooks/genesys/:integrationId` | Signed outbound Genesys message; `{"accepted":true}` |
| GET | `/media/:token` | Expiring signed media retrieval |

## Microsoft Teams Bot Framework channel

- Register an Azure Bot, enable the Microsoft Teams channel, and set its messaging endpoint to `https://<public-host>/webhooks/channel/<channelId>`.
- Configure `MicrosoftAppId` and `MicrosoftAppPassword`. For single-tenant app registrations, also configure `MicrosoftAppTenantId`; without it, token acquisition uses the legacy multi-tenant `botframework.com` authority.
- The adapter accepts Bot Framework `message` activities only. It validates the bearer JWT signature against Microsoft's published signing keys, requires issuer `https://api.botframework.com`, the configured app ID audience, an unexpired token, the activity's matching signed `serviceUrl`, and a key endorsed for the `msteams` channel.
- Text replies are sent via the Bot Framework Connector conversation activities API. The conversation reference is captured from a verified inbound message; Teams service URLs are restricted to known Bot Framework hosts.
- Only textual `message` activities are relayed. Outbound files, cards, and quick replies are downgraded to text. Install the bot in the target Team/chat and verify a real two-way exchange before enabling it for production.

Example generic inbound webhook body: `{"id":"platform-event-1","userId":"customer-1","text":"Hello","time":"2026-09-20T00:00:00Z"}`. Sign the exact raw bytes with HMAC-SHA256 and send `X-Hub-Signature-256: sha256=<hex>`. The outbound generic endpoint receives `{"id":"...","userId":"...","text":"..."}` with a Bearer token.

## Pantip Certified Developer connector contract

Pantip does not publish a general messaging API contract. This adapter connects an approved Pantip Certified Developer or partner service to the bridge. It does not scrape Pantip.

- The partner POSTs either one event or `{"events":[...]}` to `/webhooks/channel/<channelId>`.
- Sign the exact request bytes with HMAC-SHA256 using `webhookSecret`. Send `X-Pantip-Signature-256: sha256=<hex>`; `X-Hub-Signature-256` is also accepted for compatible gateways.
- An event must contain `id` or `eventId`, plus `userId`, `memberId`, or `author.id`. Text may be `text`, `message`, or `comment`. Optional fields are `timestamp`, `topicId`, `conversationId`, `author.name`, `author.avatarUrl`, and normalized `attachments`.
- For agent replies, the bridge POSTs `{"id","recipientId","text","replyToId"}` to the configured HTTPS `outboundUrl` with `Authorization: Bearer <accessToken>`. A JSON response may return an `id`.

The certified/partner service must map this contract to the Pantip interface granted to the customer account. Enable the channel only after a real comment and reply test succeeds.

The Genesys outbound webhook expects the Open Messaging normalized message. Its `channel.to.id` must contain the stable ID created by this bridge: `<channelType>:<channelConfigId>:<platformUserId>`. The handler verifies the raw-body `X-Hub-Signature-256` and queues channel delivery before responding.
