# vdkify — deploy files, get domains, connect GitHub

A self-hosted mini-Netlify in a single zero-dependency Node file. Drop a
folder (or zip, or GitHub repo) on the dashboard and it's live on its own
domain seconds later.

```sh
node server.js          # Node >= 22.5, no npm install
```

First visit asks you to set the admin password, then you're in.

## What it does

- **Free domains, zero DNS setup** — every site is instantly served at
  `http://<name>.localhost:4400/`. Browsers resolve `*.localhost` to your
  machine natively. There's also a path route (`/s/<name>/`) that works from
  any device on the network.
- **⚡ Go public in one click** — the "Go public" button in the top bar opens
  a free tunnel (localhost.run over SSH — no account, no installs) and gives
  you a real `https://….lhr.life` URL that works from anywhere on the
  internet. Every site is reachable at `<public-url>/s/<name>/` and shows its
  public link in the Domains panel.
- **Deploy anything static** — drag a folder or a `.zip` onto the site's drop
  zone (or use the pickers). `.git`/`node_modules` are skipped automatically.
  SPA routing works: extensionless misses fall back to the site's `index.html`.
- **Connect a GitHub repo** — paste `owner/repo` (public, or private with a
  token) and vdkify pulls the zipball and deploys it. One-click **Redeploy
  from GitHub** whenever you push.
- **See every deploy** — each site has a full deploy feed (Published / Failed
  with the exact error / Ready-to-restore), and the overview has a recent
  activity stream across all sites. Failed deploys never break the live site:
  the previous version keeps serving.
- **Env variables per site** — edit `KEY=value` pairs in the dashboard; your
  deployed site reads them at runtime, no rebuild:
  ```html
  <script src="/__env.js"></script>
  <script>console.log(window.ENV.API_URL)</script>
  ```
  (also served as JSON at `/__env.json`). Changes apply immediately.
- **Versioned deploys + restore** — successful deploys are kept (last 10 per
  site); restore any of them with one click.

## Going public, three ways

1. **One click (free, instant)** — hit **⚡ Go public**. You get a random
   `https://….lhr.life` URL tunneled to your machine; sites are at
   `/s/<name>/`. The URL changes each time you start the tunnel, and the
   dashboard login is exposed too — use a strong password.
2. **Your own domain, real subdomains (the full Netlify feel)** — put the
   server behind a Cloudflare Tunnel with a wildcard hostname
   (`*.sites.yourdomain.com` → your tunnel), then set in `env/.env`:
   `BASE_DOMAIN=sites.yourdomain.com`, `PUBLIC_SCHEME=https`,
   `PUBLIC_PORT=443`. Every site becomes `https://<name>.sites.yourdomain.com`
   with free TLS.
3. **A VPS** — run vdkify on it, point a wildcard DNS record at it, and put
   Caddy in front for automatic wildcard TLS.

## Real domains on your LAN

`localhost` domains only work on the machine itself. For other devices:

- **Path URLs** work everywhere as-is: `http://<server-ip>:4400/s/my-app/`
- **Wildcard LAN domains**: run dnsmasq on your network
  (`address=/.vdk.lan/192.168.1.20`) and set `BASE_DOMAIN=vdk.lan` in
  `env/.env` — now every site is `http://my-app.vdk.lan:4400/`.
- **A real domain**: point a wildcard DNS record (`*.sites.example.com`) at
  the server and set `BASE_DOMAIN=sites.example.com`.

## Config (`env/.env`)

Copy `env/.env.example` → `env/.env`. Keys: `PORT`, `BASE_DOMAIN`,
`DATA_DIR`, `DB_PATH`, `SESSION_HOURS`, `MAX_DEPLOY_MB`, `KEEP_DEPLOYS`.
Real environment variables override the file.

## Private GitHub repos

Create a fine-grained personal access token with **Contents: read** on the
repo, and paste it in the Token field when creating/connecting. Tokens are
stored in the local SQLite database (`data/vdkify.db`) — keep that file safe.

## How it's built

| Piece | How |
|---|---|
| `server.js` | everything: host-header routing, deploy API, static serving |
| zip extraction | from scratch — central-directory parse + `zlib.inflateRawSync` |
| GitHub pulls | `api.github.com/repos/<owner>/<repo>/zipball` (redirect-following) |
| storage | files on disk under `data/sites/<site>/<deploy-id>/`, metadata in SQLite (`node:sqlite`) |
| auth | single admin password (scrypt + timing-safe compare, login rate-limited), bearer sessions |
| dashboard | static UI in `ui/`, vanilla JS |

Deploys are atomic: files land in a fresh deploy directory, and the site
only flips to it once everything is written. Failed deploys are cleaned up
and the previous version keeps serving.
