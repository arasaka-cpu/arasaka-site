/*
 * Arasaka background loader — the ONLY script on the site.
 *
 * Everything animated (aurora, stars, digital rain) is computed inside
 * assets/wasm/arasaka-render.wasm. This file does nothing but:
 *   1. instantiate the module
 *   2. blit its RGBA framebuffer onto the <canvas> every rAF
 * The rest of the page is pure HTML + CSS.
 */
(function () {
  var cv = document.getElementById("bg");
  if (!cv) return;

  var useWasm = typeof WebAssembly !== "undefined";
  var ctx = cv.getContext("2d");

  if (!useWasm) {
    // No WebAssembly: static fallback gradient so the site still looks fine.
    var g = ctx.createLinearGradient(0, 0, 0, window.innerHeight);
    g.addColorStop(0, "#05070d");
    g.addColorStop(0.4, "#0b1b33");
    g.addColorStop(1, "#170a1f");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, cv.width, cv.height);
    return;
  }

  fetch("assets/wasm/arasaka-render.wasm")
    .then(function (r) { if (!r.ok) throw new Error("wasm " + r.status); return r.arrayBuffer(); })
    .then(function (bytes) { return WebAssembly.instantiate(bytes, {}); })
    .then(function (res) {
      var e = res.instance.exports;
      var W = Math.min(1024, window.innerWidth || 1024);
      var H = Math.min(576, window.innerHeight || 576);
      if (!e.init(W, H, (Math.random() * 0xffffffff) >>> 0)) throw new Error("init failed");
      cv.width = e.width();
      cv.height = e.height();
      var img = ctx.createImageData(e.width(), e.height());
      var mem = new Uint8Array(e.memory.buffer);
      var ptr = e.get_buffer();
      var len = e.width() * e.height() * 4;

      var last = 0;
      function frame(now) {
        var dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
        last = now;
        e.render(dt);
        img.data.set(mem.subarray(ptr, ptr + len));
        ctx.putImageData(img, 0, 0);
        requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    })
    .catch(function (err) {
      console.error("arasaka-render.wasm:", err);
      var g = ctx.createLinearGradient(0, 0, 0, window.innerHeight);
      g.addColorStop(0, "#05070d");
      g.addColorStop(0.4, "#0b1b33");
      g.addColorStop(1, "#170a1f");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, cv.width, cv.height);
    });
})();
