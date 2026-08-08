# Arasaka site

Static marketing site for the **Arasaka** project — a hardened, immutable
Arch + COSMIC desktop OS.

Served by GitHub Pages from the root of this repo. **No build step.**

## Pages
- `index.html` — landing / the pitch
- `about.html` — philosophy + architecture
- `missions.html` — roadmap / mission log
- `download.html` — mirrors (GitHub rolling release + B2) and install steps
- `404.html` — themed not-found page

## Fancy stuff, minus the JS
The animated background (aurora + starfield + digital rain) is computed in
**WebAssembly**: `src/arasaka-render.c` compiles to
`assets/wasm/arasaka-render.wasm` with zero libc and zero DOM access.

- `assets/js/loader.js` — the *only* script on the site; instantiates the
  module and blits its RGBA framebuffer to `<canvas id="bg">`.
- Everything else (glitch titles, ticker, scanlines, progress bars) is CSS.

### Rebuild the WASM
```sh
clang --target=wasm32-unknown-unknown -nostdlib -O2 \
      -Wl,--no-entry -Wl,--export-memory \
      -o assets/wasm/arasaka-render.wasm src/arasaka-render.c
```
