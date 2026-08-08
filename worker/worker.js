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
        const stream = assembleStream(repo, tag, manifest);
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

function assembleStream(repo, tag, manifest) {
  const parts = manifest.parts;
  const sizes = manifest.sizes;
  let i = 0;
  let reader = null;
  let got = 0;
  return new ReadableStream({
    async pull(controller) {
      for (;;) {
        if (reader) {
          const { done, value } = await reader.read();
          if (!done) {
            got += value.byteLength;
            controller.enqueue(value);
            return;
          }
          reader = null;
          const expect = sizes[i];
          if (expect && got !== expect) {
            controller.error(
              new Error(`part ${parts[i]} truncated: ${got}/${expect} bytes`)
            );
            return;
          }
          got = 0;
          i++;
        }
        if (i >= parts.length) {
          controller.close();
          return;
        }
        const name = parts[i];
        const res = await fetch(
          `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(name)}`,
          { headers: GH_UA, redirect: "follow" }
        );
        if (!res.ok) throw new Error(`part ${name}: HTTP ${res.status}`);
        if (!res.body) throw new Error(`part ${name}: no body`);
        reader = res.body.getReader();
      }
    },
    cancel() {
      if (reader) reader.cancel();
    },
  });
}
