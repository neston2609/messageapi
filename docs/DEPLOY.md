# Deploy to messageapi.demohub24.com

## Current Windows origin

The live origin is this Windows host. Cloudflare Tunnel forwards HTTPS traffic to nginx on `127.0.0.1:8080`. nginx includes `C:/MessageAPI/deploy/messageapi-nginx-windows.conf` from its `http` block and proxies this hostname to the Node process on `127.0.0.1:3000`.

`MessageAPI Bridge` is a Windows scheduled task that runs `deploy/start-windows.ps1` at the `ton_s` user logon, with restart on failure. The task requires that user to log in after a reboot. Runtime configuration and the encryption key live in `C:/MessageAPI/data/` and `C:/MessageAPI/.env`; preserve them during updates. To update the app, run `npm ci && npm run build`, then restart the scheduled task. Test `https://messageapi.demohub24.com/health` after each update.

nginx configuration is at `C:/Users/ton_s/Documents/Codex/nginx/nginx-1.30.4/conf/nginx.conf`; a timestamped backup was made before adding the include. Test with `nginx.exe -t` before reloading.

## Linux alternative

The domain currently has Cloudflare in front of an nginx origin. These deployment files assume a Linux host with systemd, nginx, Node.js 20+, and a valid origin TLS certificate. Confirm the actual server layout before applying them.

1. Copy the source to `/opt/messageapi` under a dedicated `messageapi` account. Exclude local `.env`, `data/`, `node_modules/`, and build output. On the server, run `npm ci && npm run build`.
2. Run `NODE_ENV=production HOST=127.0.0.1 PORT=3000 npm start` once to create `/opt/messageapi/.env` and `data/`. Preserve both across releases. Stop the process after checking `http://127.0.0.1:3000/health`.
3. Install `deploy/messageapi.service` in `/etc/systemd/system/`, adjust Node path if needed, then run `systemctl daemon-reload && systemctl enable --now messageapi`.
4. Install `deploy/messageapi.nginx.conf` in `/etc/nginx/sites-available/`. Set certificate paths for the actual TLS setup, enable the site, run `nginx -t`, and reload nginx. Keep Cloudflare TLS mode at Full (strict) with a valid origin certificate.
5. Verify `https://messageapi.demohub24.com/health` returns `{"status":"ok"}` and the root serves the console.

The console now has admin authentication, signature validation, and integration configuration. Keep each channel disabled until its platform credentials and two-way message delivery have passed an end-to-end test. Genesys webhooks require a public HTTPS URL on port 443. See [User manual](USER_MANUAL.md).
