/*
 * Arasaka site background renderer.
 *
 * Pure WebAssembly - no libc, no JS. Computes a full RGBA framebuffer for an
 * aurora + starfield + digital-rain effect. The ~20-line loader on the page
 * only instantiates this module and blits the framebuffer to <canvas>.
 *
 * Compile:
 *   clang --target=wasm32-unknown-unknown -nostdlib -O2 \
 *         -Wl,--no-entry -Wl,--export-memory \
 *         -o ../assets/wasm/arasaka-render.wasm arasaka-render.c
 */

typedef unsigned char u8;
typedef unsigned int  u32;
typedef int           i32;
typedef float         f32;

#define MAX_W 1280
#define MAX_H 720
#define NSTARS 160
#define NRAIN 120

static u8 fb[MAX_W * MAX_H * 4];
static i32 W, H;
static u32 rng_state;
static f32 time_acc;

typedef struct { f32 x, y, z; i32 c; } star_t;
static star_t stars[NSTARS];

typedef struct { i32 x, h; f32 y, spd; i32 len; } streak_t;
static streak_t rain[NRAIN];

static u32 rng(void) {
    rng_state ^= rng_state << 13;
    rng_state ^= rng_state >> 17;
    rng_state ^= rng_state << 5;
    return rng_state;
}

static f32 frand(void) { return (f32)(rng() & 0xffffu) / 65535.0f; }

static f32 fsin(f32 x) {
    /* range reduce to [-pi, pi], Taylor to x^9 (max err ~1e-5) */
    x = x - 6.2831853f * (f32)((i32)(x / 6.2831853f + 0.5f));
    f32 x2 = x * x;
    return x * (1.0f - x2 * (1.0f / 6.0f
        - x2 * (1.0f / 120.0f
        - x2 * (1.0f / 5040.0f
        - x2 * (1.0f / 362880.0f - x2 / 39916800.0f)))));
}

__attribute__((export_name("init")))
i32 init(i32 w, i32 h, u32 seed) {
    if (w < 8 || h < 8) return 0;
    if (w > MAX_W) w = MAX_W;
    if (h > MAX_H) h = MAX_H;
    W = w;
    H = h;
    rng_state = seed ? seed : 0x9E3779B9u;
    time_acc = 0.0f;
    i32 i;
    for (i = 0; i < NSTARS; i++) {
        stars[i].x = frand() * (f32)W;
        stars[i].y = frand() * (f32)H;
        stars[i].z = 0.3f + frand() * 0.7f;
        stars[i].c = rng() % 3;
    }
    for (i = 0; i < NRAIN; i++) {
        rain[i].x = (i32)(frand() * (f32)W);
        rain[i].y = frand() * (f32)H;
        rain[i].spd = 30.0f + frand() * 90.0f;
        rain[i].len = 8 + (i32)(frand() * 20.0f);
        rain[i].h = rng() % 3;
    }
    return 1;
}

__attribute__((export_name("render")))
void render(f32 dt) {
    if (W == 0 || H == 0) return;
    time_acc += dt;
    if (time_acc > 100.0f) time_acc -= 100.0f;
    f32 t = time_acc;
    f32 invW = 1.0f / (f32)W;
    f32 invH = 1.0f / (f32)H;
    u8 *p = fb;
    i32 x, y;
    for (y = 0; y < H; y++) {
        f32 ny = (f32)y * invH;
        f32 bg = 8.0f + 38.0f * ny; /* dark navy vertical gradient */
        for (x = 0; x < W; x++) {
            f32 nx = (f32)x * invW;
            f32 v = 0.0f;
            v += fsin(nx * 0.8f + t * 0.35f) * 0.5f;
            v += fsin(nx * 1.7f - t * 0.6f + 1.7f) * 0.5f;
            v += fsin(ny * 0.9f + t * 0.25f + 0.4f) * 0.5f;
            v += fsin(nx * 3.1f + ny * 2.2f - t * 0.5f) * 0.5f;
            f32 a = (v + 2.0f) * 0.25f;          /* 0..1 */
            f32 band = ny - 0.35f;
            if (band < 0.0f) band = -band;
            band = 1.0f - band * 1.4f;           /* strongest near y=35% */
            if (band < 0.0f) band = 0.0f;
            a *= band;
            *p++ = (u8)(a * 60.0f + bg * 0.15f);
            *p++ = (u8)(a * 220.0f + bg * 0.55f);
            *p++ = (u8)(a * 255.0f + bg * 0.65f);
            *p++ = 255;
        }
    }
    i32 i;
    for (i = 0; i < NSTARS; i++) {
        star_t *s = &stars[i];
        f32 tw = 0.35f + 0.65f * (0.5f + 0.5f * fsin(t * 2.0f + s->z * 12.0f));
        i32 xx = (i32)(s->x);
        i32 yy = (i32)(s->y);
        if (xx < 0 || xx >= W || yy < 0 || yy >= H) continue;
        u8 br = (u8)(30.0f + 170.0f * s->z * tw);
        i32 o = (yy * W + xx) * 4;
        if (s->c == 0) { fb[o] = br; fb[o + 1] = (u8)(br * 0.8f); fb[o + 2] = (u8)(br * 0.95f); }
        else if (s->c == 1) { fb[o] = (u8)(br * 0.7f); fb[o + 1] = br; fb[o + 2] = br; }
        else { fb[o] = br; fb[o + 1] = (u8)(br * 0.5f); fb[o + 2] = (u8)(br * 0.8f); }
    }
    for (i = 0; i < NRAIN; i++) {
        streak_t *r = &rain[i];
        r->y += r->spd * dt;
        if (r->y - (f32)r->len > (f32)H) {
            r->y = 0.0f;
            r->x = (i32)(frand() * (f32)W);
            r->len = 8 + (i32)(frand() * 20.0f);
            r->h = rng() % 3;
        }
        i32 cx = r->x;
        if (cx < 0 || cx >= W) continue;
        i32 cy = (i32)r->y;
        i32 k;
        for (k = 0; k < r->len; k++) {
            i32 yy = cy - k;
            if (yy < 0 || yy >= H) break;
            f32 fade = 1.0f - (f32)k / (f32)r->len;
            u8 br = (u8)(255.0f * fade * fade);
            i32 o = (yy * W + cx) * 4;
            if (r->h == 0) { fb[o] = (u8)(br * 0.1f); fb[o + 1] = br; fb[o + 2] = (u8)(br * 0.85f); }
            else if (r->h == 1) { fb[o] = (u8)(br * 0.9f); fb[o + 1] = (u8)(br * 0.1f); fb[o + 2] = br; }
            else { fb[o] = br; fb[o + 1] = br; fb[o + 2] = (u8)(br * 0.15f); }
        }
    }
}

__attribute__((export_name("get_buffer")))
u8 *get_buffer(void) { return fb; }

__attribute__((export_name("width")))
i32 width(void) { return W; }

__attribute__((export_name("height")))
i32 height(void) { return H; }
