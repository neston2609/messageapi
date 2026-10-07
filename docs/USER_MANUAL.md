# User manual: Genesys Cloud and digital channels

This guide configures the deployed bridge at **https://messageapi.demohub24.com**. The bridge receives messages from a digital platform, sends them to Genesys Cloud Open Messaging, and delivers agent replies back to the platform. One Genesys Open Messaging integration can be shared by several channel records. Configure and test one channel at a time.

## 1. Before you begin

- Confirm `https://messageapi.demohub24.com/health` returns `{"status":"ok"}`. This checks the web service only; it does not test Genesys or a channel.
- Obtain administrator access to this bridge, a Genesys Cloud organization with Open Messaging and the required Digital license/permissions, and administrator/developer access to each platform account.
- Arrange the platform's required app review, messaging permission, token scopes, and business verification before enabling production traffic. These requirements differ by platform and account.
- Keep OAuth secrets, platform tokens, and webhook secrets in the bridge console. Do not paste them into tickets or ordinary documents.

On first installation, the initial username is `admin` and the generated password is stored on the server at `C:\MessageAPI\data\config\first-run-admin.txt`. Sign in at **https://messageapi.demohub24.com**, then open **Settings > Change admin password**. The first-run file is removed after the password change. Set **Settings > Public base URL** to `https://messageapi.demohub24.com` and save. Leave the listener port at its deployed value unless the origin and nginx are changed together.

## 2. Configure Genesys Cloud

1. In Genesys Cloud, create an **OAuth client** with the **Client Credentials** grant. Give its role the permissions needed for Open Messaging inbound messages. Copy its client ID and client secret. Select the correct Genesys region, for example `mypurecloud.com` or the region of your organization. The bridge forms `https://login.<region>` and `https://api.<region>` from this value.
2. In Genesys Cloud Admin, create an **Open Messaging** platform integration under **Message > Platforms > Platform Integrations** (menu labels can vary by Genesys UI version). Record its integration ID. Configure the appropriate message flow, queue, and agent routing in Genesys so inbound conversations reach agents.
3. Generate a long random **outbound webhook signature secret**. In the bridge, open **Genesys integrations > Add integration**. Enter a local configuration ID (for example `genesys-main`), name, region, OAuth client ID/secret, Genesys Open Messaging integration ID, and that signature secret. Keep **Verify outbound signature** enabled and save. The local configuration ID identifies the record in this bridge; the Genesys integration ID is the ID from Genesys.
4. In the Genesys integrations table, click **Test**. Success confirms OAuth token acquisition only. If it fails, check the region, OAuth client, secret, grant, and role.
5. Copy the **Webhook URL** shown in the Genesys integrations table into the Genesys integration's **Outbound Notification Webhook URL**. Its form is `https://messageapi.demohub24.com/webhooks/genesys/<genesys-integration-id>`. Enter exactly the same signature secret in Genesys and save/activate the integration. Use HTTPS on standard port 443; do not append `:3000` or `:8080`.

The bridge sends inbound platform messages to the Genesys Open Messaging inbound API. Genesys posts agent replies to the outbound webhook. The bridge verifies the signature, queues the reply, then sends it through the corresponding channel. See the [Genesys Open Messaging setup guide](https://help.genesys.cloud/?p=242772).

## 3. Add a digital channel

1. Open **Channels > Add channel**. Choose a stable **Channel ID** such as `line-main`, a display name, and the platform **Type**. Choose the Genesys integration created above. Keep **Enabled** off while configuring.
2. Enter the platform credentials described below. **Rate limit** and **Maximum retries** control outbound delivery. Optional queue/flow fields are hints; configure actual routing in Genesys. Business hours default to **24/7 (always open)** when no schedule is set. Choose **Custom schedule** only when you need Monday-to-Friday start/end times and an out-of-hours auto reply.
3. Save. Copy the **Inbound webhook** URL from that channel's row: `https://messageapi.demohub24.com/webhooks/channel/<channel-id>`. Register this exact URL in the platform developer console. If the platform offers a webhook verify token, use the same token in the bridge and platform. Subscribe to the platform's message events.
4. Click **Test** in the channel row. This checks that the adapter's required configuration is present; it is not an end-to-end platform test. Open **Capabilities** for the content types the adapter handles.
5. Enable the channel, send a real message from a test user to the business account, and verify it appears in **Messages** and in a Genesys agent conversation. Reply from Genesys and confirm delivery to the test user. Check **Queue** and **Dead letters** if the reply does not arrive.

Use a distinct Channel ID and webhook URL for each business account, bot, page, or number. Changing or deleting an ID can break reply routing for existing conversations.

### Platform credential map

| Type | Credentials in the bridge | Platform setup and current behavior |
| --- | --- | --- |
| **LINE OA** | `channelSecret`, `channelAccessToken` | In the LINE Developers Messaging API channel, set its webhook URL to the bridge inbound URL, enable webhooks, and copy the channel secret and access token. The bridge verifies `X-Line-Signature`; outbound uses LINE push messages. Text and supported inbound media are handled; reply-token optimization is not implemented. [LINE webhook guide](https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/) |
| **Facebook Messenger** | `appSecret`, `verifyToken`, `pageAccessToken`, `pageId` | Configure the Meta app's Messenger webhook callback URL and verify token; subscribe the Page to message events and grant the required Page messaging permissions. Outbound supports text, image URLs, quick replies, and generic cards subject to Meta policy. |
| **Instagram DM** | `appSecret`, `verifyToken`, `pageAccessToken`, `pageId` | Configure Meta's Instagram messaging webhook for the connected professional account and Page, with the required messaging permissions. Confirm the Page ID/token pair is valid for the account. Test inbound and outbound text before enabling production traffic. |
| **WhatsApp Cloud API** | `appSecret`, `verifyToken`, `accessToken`, `phoneNumberId`; optional `fallbackTemplateName`, `fallbackTemplateLanguage` | Configure the Meta app webhook callback and verify token, subscribe to WhatsApp messages, and use a system user token and phone number ID with the required access. Outbound sends text; approved templates can be used where required by WhatsApp's conversation policy. Outbound media is not implemented. |
| **Telegram** | `webhookSecret`, `botToken` | Create a bot with BotFather. Register the bridge inbound URL with Telegram `setWebhook`, passing `secret_token` equal to `webhookSecret`; the bridge checks `X-Telegram-Bot-Api-Secret-Token`. Outbound sends text. [Telegram setWebhook](https://core.telegram.org/bots/api#setwebhook) |
| **YouTube** | Choose **OAuth 2.0**: `channelId`, `oauthClientId`, `oauthClientSecret`; or **API key**: `channelId`, `apiKey` | OAuth mode handles comment polling and replies and renews access automatically. API-key mode polls public comments only; it cannot deliver Genesys replies because YouTube write operations require OAuth. For OAuth, add `https://messageapi.demohub24.com/api/oauth/youtube/callback` as an authorized redirect URI, save, then click **Connect YouTube**. [YouTube OAuth guide](https://developers.google.com/youtube/v3/guides/auth/server-side-web-apps) |
| **X DM** | `userAccessToken`, `ownUserId` | Enable the appropriate X API DM read/write access. The bridge polls DM events and sends text replies through the X API; it does not use the inbound webhook URL. Validate token access and API plan against your X account. |
| **WeChat Official Account** | `verifyToken`, `appId`, `appSecret` | In the Official Account developer settings, set the callback URL and verification token to the bridge values. Configure **plaintext** message mode. Encrypted callback mode is not supported. Outbound uses customer-service text messages. |
| **TikTok** | `clientSecret`, `accessToken`, `businessSendUrl`; optional `commentsPollUrl` | Requires tenant-approved messaging access and an HTTPS business send endpoint. Configure the developer webhook with the bridge URL and signature secret. `commentsPollUrl` can point to an approved polling endpoint. The endpoint contract and permissions are tenant-specific; verify with your TikTok provider before enabling. |
| **Pantip.com** | `webhookSecret`, `outboundUrl`, `accessToken` | Obtain an approved API or partner endpoint through [Pantip Certified Developer](https://pantip.com/about/certified_developer). Configure that service to POST signed topic/comment events to the bridge URL and accept authenticated replies at `outboundUrl`. The bridge does not scrape Pantip and does not assume an undocumented public Pantip API. |
| **Generic REST** | `webhookSecret`, `outboundUrl`; optional `outboundToken` | POST signed JSON to the bridge inbound URL. The bridge POSTs normalized JSON to the HTTPS `outboundUrl`, using the optional Bearer token. See [API contract](API.md). |

For Meta and WhatsApp, the bridge responds to the standard GET webhook challenge when `verifyToken` matches and checks the POST `X-Hub-Signature-256` using `appSecret`. For LINE, Meta, WhatsApp, and TikTok, preserve the platform's original request body through any upstream proxy because the signature covers the raw bytes. The platform provider's developer console is the source of truth for app review, permission names, and webhook subscriptions.

## 4. Verify and operate

1. Check **Dashboard** for channel status, recent errors, queue depth, and dead letters. A green service status means the process responds; it does not prove external delivery.
2. Use **Messages** to inspect inbound/outbound records and **Sessions** to check the customer-to-Genesys conversation mapping. End a session only when you intend a new conversation for that customer.
3. Use **Queue > Retry now** or **Dead letters > Retry** after fixing a credential, network, or platform policy problem. Purge deletes pending delivery work, so use it only after confirming those messages may be discarded.
4. In **Settings**, export the encrypted configuration after changes. Back up `C:\MessageAPI\data` and `C:\MessageAPI\.env` together. An export alone cannot decrypt credentials without the matching encryption key. After rotating the key, back up the new `.env` immediately.

### Troubleshooting

| Symptom | Check |
| --- | --- |
| `/health` fails or returns 502 | Check the `MessageAPI Bridge` Windows scheduled task, Node process on `127.0.0.1:3000`, nginx on `127.0.0.1:8080`, and Cloudflare Tunnel. The scheduled task starts at the `ton_s` user logon after reboot. |
| Platform rejects webhook verification | Confirm the exact HTTPS URL, Channel ID, verification token, and platform challenge settings. |
| Webhook returns 401/403 | Compare the platform secret and signature settings; check the unmodified request body and the platform-specific signature header. |
| Message reaches bridge but not Genesys | Use Genesys integration **Test**, verify region/integration ID/OAuth role, and inspect **Messages** and server logs. OAuth success alone does not verify inbound message permission or Genesys routing. |
| Agent reply reaches bridge but not customer | Check channel credentials, platform messaging window/permissions, **Queue**, **Dead letters**, and recent errors. Retry after fixing the cause. |
| A channel shows “Ready” but no traffic | Its **Test** checks local configuration only. Send a real platform message and a real Genesys agent reply. |

For endpoint details and a signed Generic REST example, see [HTTP API](API.md). For deployment maintenance, see [Deploy](DEPLOY.md).
