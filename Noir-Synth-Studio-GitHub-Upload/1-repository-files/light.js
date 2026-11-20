// Noir Synth Studio: the light on water behind the controls, ported from the plug-in's editor.
//
// An original caustic field (domain-warped sine sheets; near their zero crossings |sin| gives bright
// filaments) drifts across a small canvas, which the browser scales up smoothly. A broad band of sun
// pans through it. Each note pulses it; each note or chord drops a ripple whose rings bend the web
// and catch the sun. Drawn at 12 fps at rest and 24 while moving, on its own layer (docs/DRAWING.md).

class NoirLight {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.w = canvas.width;
    this.h = canvas.height;
    this.image = this.ctx.createImageData(this.w, this.h);
    this.time = 0;
    this.pulse = 0;
    this.glow = 0;
    this.level = 0;
    this.ripples = [];       // { x, y (0..1 of the canvas), age }
    this.enabled = true;
    this.last = performance.now();
    this.sinceDraw = 1;
    this.sinceDrop = 1;
    this.frame = this.frame.bind(this);
    requestAnimationFrame(this.frame);
  }

  /** A note: brighten and quicken the water. */
  kick() {
    this.pulse = 1;
  }

  /** A water drop at (fx, fy), fractions of the window. A chord's notes arrive together: one drop. */
  drop(fx, fy) {
    if (this.sinceDrop < 0.07) return;
    this.sinceDrop = 0;
    this.ripples.push({ x: fx, y: fy, age: 0 });
    if (this.ripples.length > 6) this.ripples.shift();
  }

  setEnabled(on) {
    this.enabled = on;
    this.canvas.style.visibility = on ? 'visible' : 'hidden';
  }

  frame(now) {
    requestAnimationFrame(this.frame);
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.sinceDrop += dt;
    this.pulse *= Math.exp(-dt / 0.45);
    this.glow += (this.level - this.glow) * (1 - Math.exp(-dt / 0.12));
    for (const r of this.ripples) r.age += dt;
    this.ripples = this.ripples.filter((r) => r.age < 3);
    this.time += dt * (1 + 1.4 * this.pulse);
    if (!this.enabled) return;

    // 24 fps while something moves, 12 when it only drifts.
    const busy = this.pulse > 0.03 || this.glow > 0.03 || this.ripples.length > 0;
    this.sinceDraw += dt;
    if (this.sinceDraw < (busy ? 1 / 24 : 1 / 12)) return;
    this.sinceDraw = 0;
    this.render();
  }

  render() {
    const { w, h } = this;
    const t = this.time;
    const strength = 0.13 + 0.2 * this.pulse + 0.1 * this.glow;
    const d = this.image.data;

    const colU = new Float32Array(w), colWarp = new Float32Array(w), colBand = new Float32Array(w);
    const rowV = new Float32Array(h), rowWarp = new Float32Array(h), rowBand = new Float32Array(h);
    for (let x = 0; x < w; x++) {
      const u = (x / h) * 5.0 + t * 0.06;
      colU[x] = u;
      colWarp[x] = 0.55 * Math.sin(u * 1.1 - t * 0.43) + 0.3 * Math.sin(u * 2.1 + t * 0.31);
      colBand[x] = (x / w) * 1.6 * Math.PI;
    }
    for (let y = 0; y < h; y++) {
      const v = (y / h) * 5.0 + t * 0.024;
      rowV[y] = v;
      rowWarp[y] = 0.55 * Math.sin(v * 1.3 + t * 0.5) + 0.3 * Math.sin(v * 2.3 - t * 0.37);
      rowBand[y] = (y / h) * 0.7 * Math.PI + t * 0.07;
    }

    // Ripple packets in canvas pixels (the plug-in's numbers, scaled to this canvas).
    const scale = w / 260;
    const live = this.ripples.map((r) => {
      const radius = r.age * 55 * scale, sigma = (6 + r.age * 6) * scale;
      const lo = Math.max(0, radius - 3 * sigma), hi = radius + 3 * sigma;
      return { cx: r.x * w, cy: r.y * h, radius, sigma, amp: Math.exp(-r.age / 1.1) * Math.min(1, r.age / 0.04),
               inner2: lo * lo, outer2: hi * hi, k: (2 * Math.PI) / (8 * scale) };
    });

    // Colours: charcoal gradient (top #141517 -> bottom #0c0d0f), brass #c9a96b -> ivory #e9e3d5.
    const tr = 0x14, tg = 0x15, tb = 0x17, mr = 0x0c, mg = 0x0d, mb = 0x0f;
    const br = 0xc9, bgc = 0xa9, bb = 0x6b, ir = 0xe9, ig = 0xe3, ib = 0xd5;

    let i = 0;
    for (let y = 0; y < h; y++) {
      const fy = y / (h - 1);
      const baseR = tr + (mr - tr) * fy, baseG = tg + (mg - tg) * fy, baseB = tb + (mb - tb) * fy;
      const dy = fy - 0.4;
      for (let x = 0; x < w; x++, i += 4) {
        let dispX = 0, dispY = 0, crest = 0;
        for (const l of live) {
          const rx = x - l.cx, ry = y - l.cy;
          const d2 = rx * rx + ry * ry;
          if (d2 < l.inner2 || d2 > l.outer2) continue;
          const dist = Math.sqrt(d2);
          const q = (dist - l.radius) / l.sigma;
          const wave = Math.sin((dist - l.radius) * l.k) * l.amp * Math.exp(-q * q);
          const inv = 1 / (dist + 0.001);
          dispX += rx * inv * wave;
          dispY += ry * inv * wave;
          if (wave > 0) crest += wave;
        }
        const wx = colU[x] + rowWarp[y] + dispX * 0.4;
        const wy = rowV[y] + colWarp[x] + dispY * 0.4;
        const a = Math.sin(wx * 2.1 + t * 0.21) * Math.sin(wy * 1.9 - t * 0.17);
        const b = Math.sin((wx - wy) * 1.6 + t * 0.27);
        const r1 = 1 - Math.abs(a), r2 = 1 - Math.abs(b);
        const r12 = r1 * r1, r14 = r12 * r12, r22 = r2 * r2, r24 = r22 * r22;
        const c = r14 * r12 * r1 + 0.55 * r24 * r24 * r2;
        const s = 0.5 + 0.5 * Math.sin(colBand[x] - rowBand[y]);
        const band = 0.3 + 0.7 * s * s * (3 - 2 * s);
        const alpha = Math.min(0.65, c * band * strength + crest * 0.42);
        const k = Math.min(1, c + crest);
        const lr = br + (ir - br) * k, lg = bgc + (ig - bgc) * k, lb = bb + (ib - bb) * k;
        const dx = x / (w - 1) - 0.5;
        const vig = 1 - 0.35 * Math.min(1, (dx * dx + dy * dy) * 2.2);
        d[i] = (baseR + (lr - baseR) * alpha) * vig;
        d[i + 1] = (baseG + (lg - baseG) * alpha) * vig;
        d[i + 2] = (baseB + (lb - baseB) * alpha) * vig;
        d[i + 3] = 255;
      }
    }
    this.ctx.putImageData(this.image, 0, 0);
  }
}

globalThis.NoirLight = NoirLight;
