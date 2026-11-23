# SodDrop — Cloudflare deploy folder

Everything one Worker needs: the game page, its audio, and the party server play order.

| Path | What it is |
| --- | --- |
| `index.html` | The whole game (HTML + CSS + three.js client) — served as a static asset |
| `audio/menu-music.mp3`, `audio/storm-music.mp3` | Menu and in-match tracks |
| `worker/index.js` | Worker + `Party` Durable Object (one room per party code) |
| `wrangler.toml` | Worker name `soddrop`, `ASSETS` binding, `PARTY` Durable Object + migration |
| `.assetsignore` | Keeps the worker source and this folder's metadata out of the asset upload |

## Deploy with the CLI

```bash
cd deploy
npx wrangler@4 login          # once per machine
npx wrangler@4 deploy
```

The game is then at `https://soddrop.<your-subdomain>.workers.dev` and the party server on the
same origin (`/party/<CODE>/ws`), so there is no CORS or server URL to configure.

Check it without uploading:

```bash
npx wrangler@4 deploy --dry-run
```

## Deploy from GitHub Actions

The repo root already ships `.github/workflows/deploy.yml`, which deploys on every push to
`main`. It needs two repository secrets (Settings → Secrets and variables → Actions):

- `CLOUDFLARE_API_TOKEN` — a token with *Workers Scripts: Edit* and *Durable Objects: Edit*
- `CLOUDFLARE_ACCOUNT_ID`

That workflow deploys the repo root rather than this folder; both contain the same files.

## Deploy from the dashboard

Run `npx wrangler@4 deploy --dry-run --outdir dist` and upload `dist/index.js` as the Worker
code, or drag this folder into the dashboard's direct-upload flow. If you upload the folder
yourself, keep `worker` and `wrangler.toml` out of the static assets.

## Notes

- One Durable Object per party code, so a party is a single room with its own sockets; the
  migration in `wrangler.toml` (`v1`, `new_sqlite_classes = ["Party"]`) must stay.
- The host client simulates the bots and streams snapshots through the room; structures are
  broadcast as build/damage/destroy events. All of that rides the existing `/party` socket.
- Optional `[vars] COUNTDOWN_MS` shortens the ready-up countdown while testing.
- `index.html` in this folder is a build output — regenerate it from the repo root with
  `python3 .build/build.py`, then copy it here.
