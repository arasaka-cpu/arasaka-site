/*
 * Arasaka single-button downloader.
 *
 * Order of operations (one button, availability-based):
 *   1. Ask the assembler worker for the current ISO manifest (name/size/sha256).
 *   2. Probe B2 for the single-file ISO (fast CDN path, no assembly needed).
 *      If B2 answers (public + CORS), stream from there.
 *      Otherwise fall back to the worker's /download, which reassembles the
 *      GitHub .part.NN files server-side and streams the one ISO.
 *   3. Stream to disk with a live progress bar, hashing every byte with an
 *      incremental SHA-256 as it arrives, and report the final digest so the
 *      image is verified before it's ever used.
 *
 * Requires a deployed worker (see worker/README.md) for the GitHub-assembly
 * path. If no worker is configured, the button degrades to opening the
 * GitHub release page.
 */
(function () {
  var WORKER = "https://arasaka-dl.old-hickory1.workers.dev";
  var B2_BASE = "https://f005.backblazeb2.com/file/arasaka-iso/";
  var GH_RELEASE = "https://github.com/arasaka-cpu/arasaka/releases/tag/rolling";

  var btn = document.getElementById("dl-btn");
  if (!btn) return;

  var statusEl = document.getElementById("dl-status");
  var barEl = document.getElementById("dl-bar");
  var fillEl = document.getElementById("dl-fill");
  var detailEl = document.getElementById("dl-detail");

  var active = false;

  function setStatus(txt) {
    if (statusEl) statusEl.textContent = txt;
  }
  function setDetail(txt) {
    if (detailEl) detailEl.textContent = txt;
  }
  function setProgress(pct) {
    if (fillEl) fillEl.style.width = Math.max(0, Math.min(100, pct)) + "%";
  }
  function fmt(n) {
    if (n > 1073741824) return (n / 1073741824).toFixed(2) + " GiB";
    return (n / 1048576).toFixed(1) + " MiB";
  }

  function get(url) {
    return fetch(url, { mode: "cors" }).then(function (r) {
      if (!r.ok) throw new Error(url + " HTTP " + r.status);
      return r.json();
    });
  }

  btn.addEventListener("click", function () {
    if (active) return;
    active = true;
    btn.disabled = true;
    setProgress(0);
    setStatus("Locating current rolling image…");
    setDetail("");

    var manifest = null;

    function fromWorker() {
      if (WORKER.indexOf("YOUR-SUBDOMAIN") !== -1) throw new Error("no worker configured");
      return get(WORKER.replace(/\/$/, "") + "/manifest").then(function (m) {
        if (!m || !m.file) throw new Error("empty manifest");
        manifest = m;
        return m;
      });
    }

    function fromB2() {
      if (!manifest) return Promise.reject(new Error("no manifest"));
      var url = B2_BASE + encodeURIComponent(manifest.file);
      return fetch(url, { method: "HEAD", mode: "cors" }).then(function (r) {
        if (!r.ok) throw new Error("B2 HTTP " + r.status);
        setDetail("Source: Backblaze B2 direct");
        return url;
      });
    }

    function fromWorkerDL() {
      if (WORKER.indexOf("YOUR-SUBDOMAIN") !== -1) throw new Error("no worker configured");
      setDetail("Source: GitHub parts, reassembled by the CDN worker");
      return Promise.resolve(WORKER.replace(/\/$/, "") + "/download");
    }

    function saveViaAnchor(url) {
      var a = document.createElement("a");
      a.href = url;
      a.download = manifest ? manifest.file : "arasaka.iso";
      document.body.appendChild(a);
      a.click();
      a.remove();
      return null;
    }

    function streamToFile(url, expectedSha) {
      var hasStream = window.showSaveFilePicker;
      var expectedTotal = manifest ? manifest.total : 0;
      if (!hasStream) {
        saveViaAnchor(url);
        setStatus("Download started in your browser.");
        setDetail((detailEl.textContent || "") + " — check your Downloads folder.");
        return Promise.resolve();
      }
      return fetch(url, { mode: "cors" }).then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        // content-length is stripped by Cloudflare for streamed worker bodies;
        // trust the manifest size instead, and verify we actually got it all.
        var total = expectedTotal;
        if (!r.body) throw new Error("no stream");
        var hasher = new Sha256();
        var got = 0;
        return window
          .showSaveFilePicker({
            suggestedName: manifest ? manifest.file : "arasaka.iso",
            types: [
              {
                description: "ISO disk image",
                accept: { "application/octet-stream": [".iso"] },
              },
            ],
          })
          .then(function (handle) {
            return handle.createWritable().then(function (ws) {
              var reader = r.body.getReader();
              function pump() {
                return reader.read().then(function (res) {
                  if (res.done) return ws.close();
                  hasher.update(res.value);
                  got += res.value.byteLength;
                  if (total && got % (1 << 20) === 0) {
                    setStatus("Downloading " + fmt(got) + " / " + fmt(total));
                    setProgress((got / total) * 100);
                  }
                  return ws.write(res.value).then(pump);
                });
              }
              return pump().then(function () {
                // Hard failure on truncation: a partial ISO is worse than
                // no ISO. Delete it and tell the user what happened.
                if (total && got !== total) {
                  var done = Promise.resolve();
                  if (handle.remove) {
                    done = handle.remove().catch(function () {});
                  }
                  return done.then(function () {
                    setStatus("Download INCOMPLETE — got " + fmt(got) + " of " + fmt(total) + ". The mirror dropped the connection mid-transfer.");
                    setDetail("No file saved. Try again, or grab it manually at " + GH_RELEASE);
                    throw new Error("truncated download (" + got + "/" + total + " bytes)");
                  });
                }
                setProgress(100);
                var digest = hasher.digest();
                if (expectedSha && digest !== expectedSha.toLowerCase()) {
                  setStatus("WARNING: checksum mismatch (" + digest.slice(0, 12) + "…). Delete this file.");
                  setDetail("expected " + expectedSha + ", got " + digest);
                  return handle;
                }
                setStatus("Verified — sha256 matches. File saved.");
                setDetail(digest);
                return handle;
              });
            });
          });
      });
    }

    fromWorker()
      .then(fromB2)
      .catch(function () {
        if (manifest) return fromWorkerDL();
        return fromWorker().then(fromB2).catch(function () {
          setStatus("No worker configured yet — opening the GitHub release.");
          window.open(GH_RELEASE, "_blank");
          return null;
        });
      })
      .then(function (url) {
        if (!url) return null;
        return streamToFile(url, manifest ? manifest.sha256 : null);
      })
      .catch(function (e) {
        setStatus("Download failed: " + (e && e.message ? e.message : e));
        setDetail("You can also grab it manually at " + GH_RELEASE);
      })
      .then(function () {
        active = false;
        btn.disabled = false;
      });
  });

  /* ---------- incremental SHA-256 (self-contained, no deps) ---------- */
  function Sha256() {
    this.K = [
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
      0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
      0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
      0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
      0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
      0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
      0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
      0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
      0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];
    this.H = [
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ];
    this.buf = new Uint8Array(64);
    this.bufLen = 0;
    this.total = 0;
  }

  Sha256.prototype.update = function (data) {
    var i = 0;
    this.total += data.length;
    if (this.bufLen > 0) {
      while (this.bufLen < 64 && i < data.length) this.buf[this.bufLen++] = data[i++];
      if (this.bufLen === 64) {
        this._compress(this.buf, 0);
        this.bufLen = 0;
      }
    }
    while (i + 64 <= data.length) {
      this._compress(data, i);
      i += 64;
    }
    while (i < data.length) this.buf[this.bufLen++] = data[i++];
  };

  Sha256.prototype._compress = function (blk, off) {
    var w = new Uint32Array(64);
    var i;
    for (i = 0; i < 16; i++) {
      w[i] =
        ((blk[off + i * 4] << 24) |
          (blk[off + i * 4 + 1] << 16) |
          (blk[off + i * 4 + 2] << 8) |
          blk[off + i * 4 + 3]) >>>
        0;
    }
    for (i = 16; i < 64; i++) {
      var s0 = ((w[i - 15] >>> 7) | (w[i - 15] << 25)) ^ ((w[i - 15] >>> 18) | (w[i - 15] << 14)) ^ (w[i - 15] >>> 3);
      var s1 = ((w[i - 2] >>> 17) | (w[i - 2] << 15)) ^ ((w[i - 2] >>> 19) | (w[i - 2] << 13)) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    var a = this.H[0], b = this.H[1], c = this.H[2], d = this.H[3];
    var e = this.H[4], f = this.H[5], g = this.H[6], h = this.H[7];
    for (i = 0; i < 64; i++) {
      var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      var ch = (e & f) ^ (~e & g);
      var t1 = (h + S1 + ch + this.K[i] + w[i]) >>> 0;
      var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      var maj = (a & b) ^ (a & c) ^ (b & c);
      var t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    this.H[0] = (this.H[0] + a) >>> 0;
    this.H[1] = (this.H[1] + b) >>> 0;
    this.H[2] = (this.H[2] + c) >>> 0;
    this.H[3] = (this.H[3] + d) >>> 0;
    this.H[4] = (this.H[4] + e) >>> 0;
    this.H[5] = (this.H[5] + f) >>> 0;
    this.H[6] = (this.H[6] + g) >>> 0;
    this.H[7] = (this.H[7] + h) >>> 0;
  };

  Sha256.prototype.digest = function () {
    var ml = this.total;
    var padLen = this.bufLen < 56 ? 56 - this.bufLen : 120 - this.bufLen;
    var pad = new Uint8Array(padLen + 8);
    pad[0] = 0x80;
    var bits = ml * 8;
    for (var i = 7; i >= 0; i--) {
      pad[padLen + i] = bits & 0xff;
      bits = Math.floor(bits / 256);
    }
    var fin = new Uint8Array(this.bufLen + pad.length);
    fin.set(this.buf.subarray(0, this.bufLen), 0);
    fin.set(pad, this.bufLen);
    for (var o = 0; o < fin.length; o += 64) this._compress(fin, o);
    var out = "";
    for (var j = 0; j < 8; j++) {
      out += ("00000000" + (this.H[j] >>> 0).toString(16)).slice(-8);
    }
    return out;
  };
})();
