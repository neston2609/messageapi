# Add a channel adapter

1. Add a type to `channelTypes` in `src/core/config.ts`.
2. Create `src/adapters/<name>/index.ts` implementing every method in `ChannelAdapter` from `src/core/types.ts`. Declare accurate capabilities and a maximum text length.
3. Verify the platform signature against the original `rawBody` using a constant-time comparison. Reject unsigned or expired webhooks. If the platform has a GET challenge, implement `handleChallenge`.
4. Normalize events to a stable platform user ID, unique platform event ID, UTC timestamp, text, and public HTTPS media URLs. Do not use display names as identifiers.
5. Implement outbound sends with platform authentication, timeout, and explicit HTTP error handling. Downgrade unsupported content to text.
6. Register the adapter in `src/adapters/index.ts` and add credential fields to `web/src/main.tsx`.
7. Add signature, parsing, send, and mocked HTTP tests under `tests/`. Run `npm run lint && npm test && npm run build`.
8. Configure a disabled instance in the admin UI, test its credentials and webhooks, then enable it.

The server routes by `channelId`; no new HTTP route is required. Polling channels also need a worker in `src/core/polling.ts` and persisted cursors. Secrets in `credentials` are encrypted automatically by `ConfigSecrets`.
