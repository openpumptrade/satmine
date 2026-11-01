// The mine: a pixel-art cave drawn into a low-resolution buffer and scaled up
// with hard edges. A miner works the rock face while a lantern and his helmet
// lamp light the chamber in posterized, dithered bands.
//
//   setActivity({ mining, hashrate })  the miner swings faster with hashrate; each strike throws sparks
//   proof({ difficulty, accepted })    the rock cracks open and a gem flies into the cart
//   wave()                             round close: the full cart rolls away and an empty one rolls in
//   (every 12-20 s a bat flaps through the tunnel)
//   setBackdrop(on)                    calmer motion while it sits behind a page
//   clicking the cave makes the miner take one swing

const hex = s => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
const ROCK = ['#22191a', '#2e231f', '#3b2d25', '#4b392d', '#5c4636'].map(hex);
const BACK = ['#120d0b', '#16100d', '#1b1410'].map(hex);
const RIM = hex('#7a5c46');
const FLOOR_TOP = hex('#6b5040');
const GEMS = ['#ff4d6d', '#3ef0a0', '#ffc83a', '#c77dff'].map(hex);
const GOLD = hex('#ffc83a');
const SPARK = hex('#fff2a8');
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(v => (v + 0.5) / 16);
const LEVELS = [0.18, 0.34, 0.55, 0.8, 1.05];

const PAL = {
  H: '#ffc83a', h: '#c9922a', L: '#fff6c8', S: '#f0b48a', s: '#c98a63', E: '#2a1a12', M: '#5a3a22',
  B: '#c4502f', b: '#8f3720', O: '#6b4f3a', o: '#4e3a2b', K: '#2a2420', G: '#8c6b4a',
};
for (const k in PAL) PAL[k] = hex(PAL[k]);
const MINER = [
  '....hHHHHh.....',
  '...hHHHHHHHL...',
  '...hhhhhhhhhh..',
  '....SSSSSSs....',
  '....SSESSES....',
  '....SSSSSSSs...',
  '....SMMMMMs....',
  '.....sSSSs.....',
  '...bBBBBBBBb...',
  '..bBBOBBOBBB...',
  '..bBBOOOOOBB...',
  '..GbBOOOOOBb...',
  '....OOOOOOO....',
  '....OOO.OOO....',
  '....OOO.OOO....',
  '....ooo.ooo....',
  '...KKKK.KKKK...',
];
const BAT = [
  ['K.......K', 'KK.KKK.KK', '.KKKKKKK.', '...K.K...'],
  ['.........', '...KKK...', 'KKKKKKKKK', 'K..K.K..K'],
];
const GEM = ['..X..', '.XWX.', 'XXXXX', '.XXX.', '..X..'];

const clamp01 = t => Math.max(0, Math.min(1, t));
const easeOut = t => 1 - (1 - t) ** 3;
const easeInOut = t => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const hash = (i, j) => { const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453; return s - Math.floor(s); };
function vnoise(x, y, scale) {
  const fx = x / scale, fy = y / scale, i = Math.floor(fx), j = Math.floor(fy), u = fx - i, v = fy - j;
  const su = u * u * (3 - 2 * u), sv = v * v * (3 - 2 * v);
  const a = hash(i, j), b = hash(i + 1, j), c = hash(i, j + 1), d = hash(i + 1, j + 1);
  return a + (b - a) * su + (c - a) * sv + (a - b - c + d) * su * sv;
}

export class MineScene {
  constructor(canvas, { scale } = {}) {
    this.canvas = canvas;
    this.scale = scale;                   // fixed screen pixels per art pixel (brand stills); auto otherwise
    this.ctx = canvas.getContext('2d');
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.backdrop = false;

    this.mining = false;
    this.activity = 0;
    this.target = 0;
    this.time = 0;
    this.swing = 0;                       // swing phase; each whole number is one strike
    this.queued = 0;                      // strikes asked for by clicks
    this.strikes = 0;                     // strikes on the current rock (drives the cracks)
    this.shake = 0;
    this.flash = 0;
    this.particles = [];
    this.gems = [];
    this.labels = [];
    this.cartGems = [];
    this.cart = { x: 0, state: 'home', at: 0 };
    this.rockAt = -9;                     // when the current rock slid in
    this.bat = null;
    this.nextBat = 6;
    this.blinkAt = 2;

    canvas.style.cursor = 'pointer';
    canvas.addEventListener('pointerdown', () => { if (!this.backdrop) this.queued = Math.min(3, this.queued + 1); });
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
    this.last = performance.now();
    this.frame = this.frame.bind(this);
    requestAnimationFrame(this.frame);
  }

  // ---------- public ----------
  setActivity({ mining, hashrate }) {
    this.mining = mining;
    this.target = mining ? Math.min(1, Math.max(0.15, (Math.log10(Math.max(1, hashrate)) - 3) / 6)) : 0;
  }

  proof({ difficulty, accepted = true }) {
    if (!this.spots) return;
    const { rx, ry } = this.spots;
    for (let i = 0; i < (accepted ? 28 : 12); i++) {
      const c = ROCK[2 + ((Math.random() * 3) | 0)];
      this.particles.push({ x: rx + Math.random() * 14, y: ry + Math.random() * 12, vx: (Math.random() - 0.35) * 70, vy: -30 - Math.random() * 60, life: 1.4, born: this.time, c, bounce: true });
    }
    this.shake = 0.18;
    this.strikes = 0;
    this.rockAt = this.time + 0.35;
    if (!accepted) {
      this.labels.push({ x: rx + 6, y: ry - 6, born: this.time, text: 'dud', bad: true });
      return;
    }
    this.flash = 1;
    const color = GEMS[(this.gems.length + this.cartGems.length + difficulty) % GEMS.length];
    this.gems.push({ from: [rx + 5, ry + 2], born: this.time, color });
    this.labels.push({ x: rx + 6, y: ry - 6, born: this.time, text: `+2^${difficulty}` });
    if (this.labels.length > 4) this.labels.shift();
  }

  wave() {
    if (this.cart.state !== 'home') return;
    this.cart = { x: 0, state: 'leaving', at: this.time };
  }

  setBackdrop(on) { this.backdrop = on; }

  // ---------- setup ----------
  resize() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    const { width, height } = this.canvas.getBoundingClientRect();
    this.w = width; this.h = height; this.dpr = dpr;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    if (!width || !height) return;
    const P = this.scale ?? (width < 600 ? 3 : Math.max(2, Math.round(Math.min(width / 210, height / 140))));
    const W = Math.ceil(width / P), H = Math.ceil(height / P);
    this.P = P; this.W = W; this.H = H;
    this.buf = Object.assign(document.createElement('canvas'), { width: W, height: H });
    this.bctx = this.buf.getContext('2d');
    this.img = this.bctx.createImageData(W, H);
    this.build();
  }

  // The static cave: which pixels are open air, the rock's base colors, ore flecks.
  build() {
    const { W, H } = this;
    const cx = Math.round(W / 2), ground = Math.round(H * 0.62);
    const rx = Math.min(W * 0.34, 105), ry = 36;
    const open = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const n = vnoise(x, y, 7) - 0.5;
      const dome = ((x - cx) / rx) ** 2 + ((y - ground) / ry) ** 2 < 1 + n * 0.5;
      const tunnel = y > ground - 19 + Math.round(n * 4) && y <= ground;
      if (y <= ground && (dome || tunnel)) open[y * W + x] = 1;
    }
    const base = new Uint8ClampedArray(W * H * 3);
    this.ore = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      let c;
      if (open[i]) {
        const n = vnoise(x, y, 5) + hash(x, y) * 0.25;
        c = BACK[n > 0.95 ? 2 : n > 0.6 ? 1 : 0];
      } else {
        const strata = Math.sin(y * 0.33 + vnoise(x, y, 18) * 4) * 0.12;
        const n = vnoise(x, y, 6) * 0.55 + vnoise(x, y, 2.5) * 0.35 + hash(x, y) * 0.18 + strata;
        c = ROCK[Math.max(0, Math.min(4, Math.floor(n * 4.2 - 0.6)))];
        const above = y > 0 && open[i - W], beside = (x > 0 && open[i - 1]) || (x < W - 1 && open[i + 1]), below = y < H - 1 && open[i + W];
        if (above) c = FLOOR_TOP;
        else if (beside || below) c = RIM;
        else if (hash(x * 3, y * 7) < 0.0025) this.ore.push({ x, y, c: GEMS[(hash(x, y) * 4) | 0], ph: hash(y, x) * 6.28 });
      }
      base.set(c, i * 3);
    }
    this.open = open; this.base = base;
    // where things stand; pulled in a little on narrow screens
    const u = Math.min(1, W / 230);
    this.spots = {
      cx, ground,
      mx: cx - 2, my: ground - 17,                       // miner's top-left
      rx: cx + Math.round(16 * u) + 6, ry: ground - 12,  // rock face top-left
      cartX: cx - Math.round(26 * u) - 18,               // cart's home x
      lx: cx - Math.round(14 * u), ly: ground - ry + 6,  // lantern
    };
  }

  // ---------- frame ----------
  frame(now) {
    requestAnimationFrame(this.frame);
    if (!this.w || !this.buf || document.hidden) { this.last = now; return; }
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.time += dt;
    this.update(dt);
    this.draw();
  }

  update(dt) {
    const t = this.time, calm = this.backdrop ? 0.5 : 1;
    this.activity += (this.target - this.activity) * Math.min(1, dt * 1.8);
    this.shake = Math.max(0, this.shake - dt);
    this.flash = Math.max(0, this.flash - dt * 1.5);

    // swinging: continuous while mining, one swing per click otherwise
    const rate = this.mining ? (1.4 + this.activity * 6) * calm : (this.queued ? 2.2 : 0);
    if (rate && !this.reduced) {
      const before = this.swing;
      this.swing += dt * rate;
      if (Math.floor(this.swing) > Math.floor(before)) this.strike();
    } else if (!this.mining) {
      this.swing = Math.ceil(this.swing - 0.001);       // settle at rest between strikes
    }

    // gems arc into the cart
    for (const g of this.gems) if (!g.landed && t - g.born > 0.8) {
      g.landed = true;
      if (this.cart.state === 'home') { this.cartGems.push(g.color); if (this.cartGems.length > 14) this.cartGems.shift(); }
    }
    this.gems = this.gems.filter(g => !g.landed);

    // cart: leave with the haul, come back empty
    const c = this.cart, away = this.spots.cartX + 40;
    if (c.state === 'leaving') {
      const k = clamp01((t - c.at) / 1.3);
      c.x = -easeInOut(k) * away;
      if (k >= 1) { this.cartGems = []; this.cart = { x: -away, state: 'arriving', at: t }; }
    } else if (c.state === 'arriving') {
      const k = clamp01((t - c.at) / 1.1);
      c.x = -(1 - easeOut(k)) * away;
      if (k >= 1) this.cart = { x: 0, state: 'home', at: t };
    }

    if (!this.reduced && !this.backdrop && t > this.nextBat) {
      this.bat = { born: t, dir: Math.random() < 0.5 ? 1 : -1, y: this.spots.ground - 14 - Math.random() * 14 };
      this.nextBat = t + 12 + Math.random() * 8;
    }
    if (this.bat && t - this.bat.born > 4) this.bat = null;

    // dust drifting through the lamplight
    if (!this.reduced && Math.random() < dt * 3 * calm) {
      const { lx, ly } = this.spots;
      this.particles.push({ x: lx + (Math.random() - 0.5) * 60, y: ly + Math.random() * 30, vx: (Math.random() - 0.5) * 3, vy: 1 + Math.random() * 2, life: 4, born: t, c: [150, 125, 100], dust: true });
    }
    for (const p of this.particles) {
      if (!p.dust) p.vy += 150 * dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.bounce && p.y > this.spots.ground) { p.y = this.spots.ground; p.vy *= -0.3; p.vx *= 0.6; }
    }
    this.particles = this.particles.filter(p => t - p.born < p.life).slice(-260);
    this.labels = this.labels.filter(l => t - l.born < 1.6);
  }

  strike() {
    if (this.queued) this.queued--;
    this.strikes++;
    const { rx, ry } = this.spots;
    for (let i = 0; i < 5; i++) this.particles.push({ x: rx, y: ry + 5 + Math.random() * 4, vx: -25 - Math.random() * 45, vy: -35 + Math.random() * 30, life: 0.3, born: this.time, c: SPARK });
    if (Math.random() < 0.5) this.particles.push({ x: rx + 1, y: ry + 6, vx: -15 - Math.random() * 20, vy: -20, life: 1, born: this.time, c: ROCK[3], bounce: true });
  }

  // ---------- drawing ----------
  draw() {
    const { W, H, P, img, base } = this;
    const d = img.data, t = this.time;
    const { lx, ly, mx, my } = this.spots;
    if (!this.light || this.light.length !== W * H) this.light = new Float32Array(W * H);
    const light = this.light;
    const flicker = 1 + Math.sin(t * 13) * 0.03 + Math.sin(t * 7.3) * 0.04;
    const lamps = [
      [lx, ly + 4, 105 * flicker * (1 + this.flash * 0.25), 1],
      [mx + 11, my + 1, 34 + this.activity * 10, 0.75],
    ];
    // light pass: posterized bands with ordered dithering
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let b = 0.2;
      for (const [sx, sy, r, k] of lamps) {
        const dd = Math.hypot(x - sx, (y - sy) * 1.15) / r;
        if (dd < 1) b = Math.max(b, (1 - dd) ** 1.2 * k + 0.2);
      }
      const dither = BAYER[(y & 3) * 4 + (x & 3)] * 0.16 - 0.08;
      let lv = LEVELS[0];
      for (const L of LEVELS) if (b + dither >= L - 0.12) lv = L;
      const i = y * W + x, o = i * 4;
      light[i] = lv;
      d[o] = base[i * 3] * lv; d[o + 1] = base[i * 3 + 1] * lv; d[o + 2] = base[i * 3 + 2] * lv; d[o + 3] = 255;
    }
    // ore flecks glint now and then, only where the light reaches
    for (const o of this.ore) {
      const g = Math.sin(t * 1.7 + o.ph), lit = this.light[o.y * W + o.x];
      if (lit > 0.3) this.px(o.x, o.y, o.c, (g > 0.6 ? 0.45 + (g - 0.6) * 1.3 : 0.25) * Math.min(1, lit));
    }

    this.drawRails();
    this.drawLantern();
    this.drawRock();
    this.drawCart();
    this.drawMiner();
    for (const g of this.gems) {
      const k = clamp01((t - g.born) / 0.8);
      const tx = this.spots.cartX + this.cart.x + 8, ty = this.spots.ground - 10;
      const x = g.from[0] + (tx - g.from[0]) * k, y = g.from[1] + (ty - g.from[1]) * k - Math.sin(Math.PI * k) * 30;
      this.sprite(GEM, x - 2, y - 2, { X: g.color, W: [255, 255, 255] });
    }
    for (const p of this.particles) {
      const a = p.dust ? Math.sin(Math.PI * (t - p.born) / p.life) * 0.35 : 1;
      this.px(p.x, p.y, p.c, a);
    }
    if (this.bat) {
      const k = (t - this.bat.born) / 4, x = this.bat.dir > 0 ? -10 + k * (W + 20) : W + 10 - k * (W + 20);
      this.sprite(BAT[Math.floor(t * 10) % 2], x, this.bat.y + Math.sin(t * 6) * 3, { K: [24, 18, 16] });
    }

    this.bctx.putImageData(img, 0, 0);
    const { ctx, dpr, w, h } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = false;
    const sx = this.shake > 0 ? Math.round((Math.random() - 0.5) * 2) * P : 0;
    const sy = this.shake > 0 ? Math.round((Math.random() - 0.5) * 2) * P : 0;
    ctx.drawImage(this.buf, sx, sy, W * P, H * P);
    this.drawLabels();
  }

  // Blend one buffer pixel toward color c.
  px(x, y, c, a = 1) {
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= this.W || y >= this.H) return;
    const o = (y * this.W + x) * 4, d = this.img.data;
    d[o] += (c[0] - d[o]) * a; d[o + 1] += (c[1] - d[o + 1]) * a; d[o + 2] += (c[2] - d[o + 2]) * a;
  }

  sprite(rows, x, y, colors = PAL) {
    rows.forEach((row, j) => {
      for (let i = 0; i < row.length; i++) if (row[i] !== '.' && colors[row[i]]) this.px(x + i, y + j, colors[row[i]]);
    });
  }

  drawRails() {
    const { W } = this, g = this.spots.ground;
    for (let x = 0; x < W; x++) {
      if (!this.open[(g - 1) * W + x]) continue;
      if (x % 5 === 0) { this.px(x, g, [74, 52, 36]); this.px(x + 1, g, [74, 52, 36]); }
      this.px(x, g - 1, [128, 124, 118]);
    }
  }

  drawLantern() {
    const { lx, ly } = this.spots, t = this.time;
    const sway = Math.round(Math.sin(t * 1.3) * (this.cart.state === 'home' ? 0.6 : 1.6));
    for (let y = ly - 14; y < ly; y++) if (y % 2 === 0) this.px(lx + Math.round(sway * (y - ly + 14) / 14), y, [90, 80, 70]);
    const glow = 0.85 + Math.sin(t * 11) * 0.15;
    this.sprite(['.KKK.', 'KLLLK', 'KLHLK', 'KLLLK', '.KKK.'], lx + sway - 2, ly, { K: [60, 48, 36], L: [255, 220 * glow, 120 * glow], H: [255, 250, 220] });
  }

  // The rock face: slides in after a break, cracks spread with each strike.
  drawRock() {
    const { rx, ry } = this.spots, t = this.time;
    if (t < this.rockAt) return;
    const ox = Math.round((1 - easeOut(clamp01((t - this.rockAt) / 0.4))) * 10);
    for (let j = 0; j < 12; j++) for (let i = 0; i < 14; i++) {
      if ((i < 2 && j < 2) || (i > 12 && j < 1)) continue;
      const edge = i === 0 || j === 0;
      this.px(rx + i + ox, ry + j, edge ? [138, 106, 84] : hash(i + 40, j + 9) > 0.7 ? [107, 85, 70] : [92, 72, 58]);
    }
    // a vein of ore showing through
    this.px(rx + 7 + ox, ry + 5, GOLD); this.px(rx + 8 + ox, ry + 6, GOLD); this.px(rx + 5 + ox, ry + 8, GEMS[0]);
    const cracks = Math.min(5, Math.floor(this.strikes / 2));
    for (let k = 0; k < cracks; k++) {
      let x = rx + 1 + ox, y = ry + 2 + k * 2;
      for (let s = 0; s < 4 + k; s++) { this.px(x, y, [30, 22, 18]); x += 1; y += hash(k, s) > 0.5 ? 1 : 0; }
    }
  }

  drawCart() {
    const g = this.spots.ground, x = Math.round(this.spots.cartX + this.cart.x), y = g - 9;
    const wood = [122, 59, 38], rim = [155, 82, 54], dark = [74, 36, 24];
    for (let j = 0; j < 7; j++) for (let i = 0; i < 18; i++) {
      if (j > 4 && (i < 1 || i > 16)) continue;
      this.px(x + i, y + j, j === 0 ? rim : i % 6 === 0 ? dark : wood);
    }
    // the haul, piled up
    this.cartGems.forEach((c, k) => {
      const gx = x + 2 + (k % 7) * 2, gy = y - 1 - Math.floor(k / 7) * 2 - (k % 2);
      this.px(gx, gy, c); this.px(gx + 1, gy, c); this.px(gx, gy - 1, [255, 255, 255], 0.6);
    });
    const spin = this.cart.state !== 'home' && Math.floor(this.time * 12) % 2;
    for (const wx of [x + 3, x + 12]) {
      this.sprite(['.KK.', 'KHKK', 'KKHK', '.KK.'].map(r => (spin ? [...r].reverse().join('') : r)), wx, g - 3, { K: [34, 30, 28], H: [110, 104, 96] });
    }
  }

  drawMiner() {
    const { mx, my } = this.spots, t = this.time;
    // idle: pick on the shoulder, a blink every few seconds; working: a hard down-stroke, slower recovery
    const phase = this.swing % 1;
    const working = this.mining || this.queued || phase > 0.001;
    let ang;
    if (working && !this.reduced) ang = phase < 0.35 ? -2.5 + easeInOut(phase / 0.35) * 2.9 : 0.4 - easeOut((phase - 0.35) / 0.65) * 2.9;
    else ang = -2.3 + Math.sin(t * 1.5) * 0.05;
    const bob = working && phase < 0.35 ? 1 : 0;
    if (t > this.blinkAt + 0.12) this.blinkAt = t + 2.5 + Math.random() * 3;
    const rows = t > this.blinkAt ? MINER.map((r, j) => (j === 4 ? r.replace(/E/g, 'S') : r)) : MINER;
    // the pick sits behind the body when raised, in front when striking
    const pick = () => {
      const hx = mx + 11, hy = my + 10 + bob;
      for (let k = 0; k < 12; k++) this.px(hx + Math.cos(ang) * k, hy + Math.sin(ang) * k, PAL.G);
      const ex = hx + Math.cos(ang) * 12, ey = hy + Math.sin(ang) * 12, nx = Math.cos(ang + Math.PI / 2), ny = Math.sin(ang + Math.PI / 2);
      for (let k = -4; k <= 4; k++) {
        const curve = Math.abs(k) * 0.35;
        this.px(ex + nx * k - Math.cos(ang) * curve, ey + ny * k - Math.sin(ang) * curve, Math.abs(k) > 3 ? [230, 226, 220] : [178, 172, 164]);
      }
    };
    if (ang < -1.2) pick();
    this.sprite(rows, mx, my + bob);
    if (ang >= -1.2) pick();
  }

  drawLabels() {
    if (this.backdrop || !this.labels.length) return;
    const { ctx, P } = this;
    ctx.font = `${P * 4}px "Silkscreen", ui-monospace, monospace`;
    ctx.textAlign = 'center';
    for (const l of this.labels) {
      const k = (this.time - l.born) / 1.6;
      const a = k < 0.1 ? k / 0.1 : 1 - (k - 0.1) / 0.9;
      const x = l.x * P, y = (l.y - easeOut(k) * 14) * P;
      ctx.fillStyle = `rgba(0,0,0,${a})`;
      ctx.fillText(l.text, x + P / 2, y + P / 2);
      ctx.fillStyle = l.bad ? `rgba(255,90,80,${a})` : `rgba(255,200,58,${a})`;
      ctx.fillText(l.text, x, y);
    }
    ctx.textAlign = 'start';
  }
}
