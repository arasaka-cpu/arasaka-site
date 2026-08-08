# Arasaka ISO assembler worker

GitHub release assets are split into 1 GiB `.part.NN` files (GitHub's per-asset
cap is 2 GiB), and GitHub's asset host sends **no CORS headers** — so a browser
cannot fetch the parts to reassemble them. This worker fetches the parts
server-side, concatenates them in order, and streams the single assembled ISO
to the client with CORS enabled.

## Endpoints
- `GET /manifest` — JSON: `{ file, total, sha256, parts, sizes }`
- `GET /download` — streamed ISO, `Content-Length` set, sha256 in
  `x-arasaka-sha256`

## Deploy

```sh
cd worker
npm i -g wrangler   # or: npx wrangler
wrangler login
wrangler deploy
```

That yields `https://arasaka-dl.<your-subdomain>.workers.dev`.

## Wire it into the site
In `assets/js/download.js`, set:

```js
var WORKER = "https://arasaka-dl.YOUR-SUBDOMAIN.workers.dev";
```

The button then: probes B2 (single file) → falls back to this worker's
`/download` (GitHub parts assembled) → both verify the sha256 in-browser.

## Auto-deploy on push
`.github/workflows/deploy-worker.yml` deploys the worker on every push to
`main` that touches `worker/`. Add two repo secrets:
- `CLOUDFLARE_API_TOKEN` — an API token with `Workers Scripts: Edit`
- `CLOUDFLARE_ACCOUNT_ID` — your Cloudflare account id

Until the workflow runs, the worker deploys manually with `wrangler deploy`.
