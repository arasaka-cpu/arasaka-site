# Arasaka ISO assembler worker

GitHub release assets are split into 1 GiB `.part.NN` files (GitHub's per-asset
cap is 2 GiB), and GitHub's asset host sends **no CORS headers** — so a browser
cannot fetch the parts to reassemble them. This worker fetches the parts
server-side, concatenates them in order, and streams the single assembled ISO
to the client with CORS enabled.

**In plain words:** the website's one download button asks this worker "what's
the current ISO and where are its parts?", the worker pulls the parts from
GitHub's servers (servers can talk to each other — no CORS problem), glues
them together, and streams one complete `.iso` to your browser. The browser
checks the sha256 as it goes.

## Endpoints
- `GET /manifest` — JSON: `{ file, total, sha256, parts, sizes }`
- `GET /download` — streamed ISO, `Content-Length` set, sha256 in
  `x-arasaka-sha256`

## What a "worker" is (60-second version)

A Cloudflare Worker is a tiny piece of code that runs on Cloudflare's servers,
right next to their fast CDN. You don't rent a server, you don't install
anything, and it costs nothing for this kind of use. We "deploy" it by sending
the code file to Cloudflare. That's the whole job. Free account needed.

---

## Guide A — Deploy from the Cloudflare dashboard (no terminal needed)

1. **Create a Cloudflare account** (free):
   - Go to https://dash.cloudflare.com/sign-up and register (email + password).

2. **Open Workers & Pages**:
   - After login, the left menu has **Workers & Pages**. Click it, then click
     **Create application**, then **Create Worker**.

3. **Set the name**: name it exactly `arasaka-dl` (that name becomes part of
   the URL). Click **Deploy** (it creates a trivial "Hello World" worker).

4. **Paste our code**:
   - On the worker's page, click **Edit code**.
   - Select everything in the editor (Ctrl+A / Cmd+A) and delete it.
   - Open this repo's `worker/worker.js` in any text editor, copy the whole
     file, paste it into Cloudflare's editor.
   - Click **Save and Deploy** (top right).

5. **Copy your URL**: the page shows something like
   `https://arasaka-dl.<your-subdomain>.workers.dev`. Your subdomain is
   `workers.dev` plus whatever Cloudflare assigned when you registered.

6. **Tell the site about it**: open `assets/js/download.js` in this repo and
   set line 19:
   ```js
   var WORKER = "https://arasaka-dl.YOUR-SUBDOMAIN.workers.dev";
   ```
   (replace `YOUR-SUBDOMAIN` with the real one), then commit + push to `main`.
   GitHub Pages publishes it automatically within a minute.

7. **Test**: open the live Download page, click the button. Status should read
   "Source: GitHub parts, reassembled by the CDN worker" and the progress bar
   should move.

---

## Guide B — Deploy from your own computer (needs Node.js, optional)

Only if you already have Node installed:

```sh
cd worker
npm i -g wrangler       # one-time install
wrangler login          # opens a browser tab to authorize
wrangler deploy         # uploads and prints your workers.dev URL
```

Then do step 6 of Guide A to wire the URL into the site.

---

## Guide C — Auto-deploy on every push (frees you from doing it again)

Once the worker exists, you can make GitHub redeploy it automatically whenever
you change `worker/`. This needs two "secrets" in your repo settings:

1. In Cloudflare, go to **My Profile → API Tokens → Create Token**, choose the
   **Edit Cloudflare Workers** template, and note the token (it shows once).
2. Go to your GitHub repo → **Settings → Secrets and variables → Actions** →
   **New repository secret**:
   - `CLOUDFLARE_API_TOKEN` = the token from step 1
   - `CLOUDFLARE_ACCOUNT_ID` = your Cloudflare Account ID
     (visible on the dashboard sidebar; a 32-char hex string)

The workflow `.github/workflows/deploy-worker.yml` then deploys on every push
to `main` that touches `worker/`.

---

## Troubleshooting

- **Download button says "no worker configured"** → `WORKER` in
  `assets/js/download.js` still has the placeholder text; finish Guide A step 6.
- **Button opens GitHub instead of downloading** → same cause, the fallback
  behavior.
- **"part ... truncated"** → the worker's own safety check caught a broken
  download; just retry.
- **Wrangler needs a payment method** → not for Workers Free. If prompted
  during `wrangler deploy`, you picked a paid plan; the dashboard (Guide A) is
  free and simpler.
