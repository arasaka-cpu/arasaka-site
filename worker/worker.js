/*
 * Arasaka ISO assembler worker.
 *
 * Why this exists: GitHub release assets are split into 1 GiB .part.NN files
 * (2 GiB per-asset cap), and GitHub's asset host does NOT send CORS headers -
 * so a browser cannot read the parts to reassemble them. This worker fetches
 * the parts server-side (no CORS), concatenates them in order, and streams the
 * single assembled ISO to the client with CORS enabled.
 *
 * Endpoints:
 *   GET /manifest  -> { file, total, sha256, parts, sizes }
 *   GET /download  -> streamed assembled ISO (Content-Length + sha256 header)
 *
 * Deploy: cd worker && npx wrangler deploy   (see README)
 */

const GH_UA = {
  "User-Agent": "arasaka-site-worker",
  "Accept": "application/vnd.github+json",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Cache-Control": "no-store",
    };
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }

    const repo = env.REPO || "arasaka-cpu/arasaka";
    const tag = env.TAG || "rolling";

    try {
      const info = await releaseInfo(repo, tag);
      const manifest = await getManifest(repo, tag, info);

      if (url.pathname === "/manifest") {
        return new Response(JSON.stringify(manifest), {
          headers: { ...headers, "Content-Type": "application/json" },
        });
      }

      if (url.pathname === "/download") {
        const stream = await buildStream(env, repo, tag, manifest);
        return new Response(stream, {
          headers: {
            ...headers,
            "Content-Type": "application/octet-stream",
            "Content-Length": String(manifest.total),
            "Content-Disposition": `attachment; filename="${manifest.file}"`,
            "x-arasaka-sha256": manifest.sha256,
          },
        });
      }

      return new Response(
        "Arasaka ISO assembler.\nUse /manifest or /download.\n",
        { headers: { ...headers, "Content-Type": "text/plain" } }
      );
    } catch (e) {
      const msg = String((e && e.message) || e);
      return new Response(JSON.stringify({ error: msg }), {
        status: 502,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }
  },
};

/* ------------------------------------------------------------------ */
/* Source selection                                                     */
/*                                                                      */
/* Priority:                                                           */
/*   1. B2 (env.B2_KEY_ID + env.B2_KEY) - private bucket, streamed     */
/*      server-side. B2 does not throttle datacenter IPs the way        */
/*      GitHub's release CDN does, so large downloads complete.         */
/*   2. GitHub 1 GiB parts (reassembled) - fallback.                    */
/*   3. Internet Archive (env.IA_URL) - reserved; becomes source #1     */
/*      once the ISO is mirrored there.                                 */
/* ------------------------------------------------------------------ */

async function buildStream(env, repo, tag, manifest) {
  if (env.IA_URL) {
    try {
      return await iaStream(env.IA_URL, manifest.total);
    } catch (e) {
      // fall through to B2 / GitHub
    }
  }
  // B2 single-file ISO first (no GitHub part assembly, no DC throttling).
  // Try the public read path first, then the authenticated path if creds
  // are configured. Either way a 401/404 falls through to GitHub parts.
  try {
    const pub = await fetch(publicB2Url(env, manifest.file));
    if (pub.ok && pub.body) return verifiedStream(pub.body, manifest.total);
  } catch (e) {
    /* fall through */
  }
  if (env.B2_KEY_ID && env.B2_KEY) {
    try {
      return await b2Stream(env, manifest.file, manifest.total);
    } catch (e) {
      // fall through to GitHub parts
    }
  }
  return assembleStream(repo, tag, manifest);
}

function publicB2Url(env, fileName) {
  const host = env.B2_DL_HOST || "https://f005.backblazeb2.com";
  const bucket = env.B2_BUCKET || "arasaka-iso";
  return `${host}/file/${encodeURIComponent(bucket)}/${encodeURIComponent(fileName)}`;
}

async function b2Stream(env, fileName, total) {
  const b2 = await fetch("https://api.backblazeb2.com/b2api/v3/b2_authorize_account", {
    headers: {
      Authorization:
        "Basic " +
        btoa(`${env.B2_KEY_ID}:${env.B2_KEY}`),
    },
  });
  if (!b2.ok) throw new Error(`B2 authorize HTTP ${b2.status}`);
  const auth = await b2.json();
  const token = auth.authorizationToken;
  const dlBase = (auth.apiInfo && auth.apiInfo.storageApi && auth.apiInfo.storageApi.downloadUrl) ||
    auth.apiInfo.downloadUrl ||
    "https://f005.backblazeb2.com";
  const bucket = env.B2_BUCKET || "arasaka-iso";
  const dl = await fetch(
    `${dlBase}/file/${encodeURIComponent(bucket)}/${encodeURIComponent(fileName)}`,
    { headers: { Authorization: token } }
  );
  if (!dl.ok) throw new Error(`B2 download HTTP ${dl.status}`);
  if (!dl.body) throw new Error("B2 download: no body");
  return verifiedStream(dl.body, total);
}

async function iaStream(url, total) {
  const res = await fetch(url, { headers: { "User-Agent": "arasaka-site-worker" } });
  if (!res.ok) throw new Error(`IA HTTP ${res.status}`);
  if (!res.body) throw new Error("IA download: no body");
  return verifiedStream(res.body, total);
}

/* Wrap an upstream body so that a shorter-than-expected transfer fails
 * the response stream instead of silently truncating the download. */
function verifiedStream(body, total) {
  let got = 0;
  const reader = body.getReader();
  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          if (got !== total) {
            controller.error(new Error(`transfer ended early: ${got}/${total} bytes`));
            return;
          }
          controller.close();
          return;
        }
        got += value.byteLength;
        controller.enqueue(value);
      } catch (e) {
        controller.error(e);
      }
    },
    cancel() {
      reader.cancel();
    },
  });
}

async function releaseInfo(repo, tag) {
  const res = await fetch(
    `https://api.github.com/repos/${repo}/releases/tags/${tag}`,
    { headers: GH_UA }
  );
  if (!res.ok) throw new Error(`release lookup HTTP ${res.status}`);
  return await res.json();
}

async function getManifest(repo, tag, release) {
  const asset = (release.assets || []).find((a) =>
    /\.iso\.parts\.json$/.test(a.name)
  );
  if (!asset) throw new Error("no .iso.parts.json asset in release");
  const sizes = {};
  for (const a of release.assets || []) {
    if (/\.iso\.part\.\d+$/.test(a.name)) sizes[a.name] = a.size;
  }
  const mres = await fetch(asset.browser_download_url, { headers: GH_UA });
  if (!mres.ok) throw new Error(`manifest HTTP ${mres.status}`);
  const m = await mres.json();
  m.sizes = m.parts.map((p) => sizes[p] || 0);
  return m;
}

const PART_MAX_ATTEMPTS = 5;

async function fetchPart(repo, tag, name) {
  const url =
    `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(name)}`;
  let lastErr = null;
  for (let attempt = 1; attempt <= PART_MAX_ATTEMPTS; attempt++) {
    const res = await fetch(url, { headers: GH_UA, redirect: "follow" });
    if (!res.ok) {
      lastErr = new Error(`part ${name}: HTTP ${res.status}`);
      if (attempt === PART_MAX_ATTEMPTS) throw lastErr;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
      continue;
    }
    if (!res.body) {
      lastErr = new Error(`part ${name}: no body`);
      if (attempt === PART_MAX_ATTEMPTS) throw lastErr;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
      continue;
    }
    return res;
  }
  throw lastErr || new Error(`part ${name}: unreachable`);
}

function assembleStream(repo, tag, manifest) {
  const parts = manifest.parts;
  const sizes = manifest.sizes;
  let i = 0;
  let reader = null;
  let got = 0;
  let total = 0;
  return new ReadableStream({
    async pull(controller) {
      for (;;) {
        if (reader) {
          let res;
          try {
            res = await reader.read();
          } catch (e) {
            // Mid-part network drop (GitHub throttles large DC downloads).
            // We cannot retry here - bytes already streamed to the client
            // cannot be taken back. Error the stream loudly so the client
            // detects the short transfer and rejects the file.
            reader = null;
            got = 0;
            controller.error(
              new Error(`part ${parts[i] || "?"} stream dropped: ${e && e.message ? e.message : e}`)
            );
            return;
          }
          const { done, value } = res;
          if (!done) {
            got += value.byteLength;
            total += value.byteLength;
            controller.enqueue(value);
            return;
          }
          reader = null;
          const expect = sizes[i];
          if (expect && got !== expect) {
            // Short part: GitHub cut the transfer. The client will get a clean
            // EOF with fewer bytes than Content-Length advertised, which is
            // how they detect and reject the truncated file.
            controller.error(
              new Error(`part ${parts[i]} truncated: ${got}/${expect} bytes`)
            );
            return;
          }
          got = 0;
          i++;
        }
        if (i >= parts.length) {
          if (total !== manifest.total) {
            controller.error(
              new Error(`assembled ${total}/${manifest.total} bytes (truncated)`)
            );
            return;
          }
          controller.close();
          return;
        }
        const name = parts[i];
        const res = await fetchPart(repo, tag, name);
        reader = res.body.getReader();
      }
    },
    cancel() {
      if (reader) reader.cancel();
    },
  });
}
