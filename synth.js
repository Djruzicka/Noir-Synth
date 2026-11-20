// Noir Synth Studio: the in-window Web Audio engine (copied unchanged from the Noir Synth Add On). An 8-voice analog-style polysynth:
// per voice two detuned oscillators + a sub octave, a resonant 24 dB low-pass (two biquads)
// with its own envelope, an amp envelope, and glide. Then a stereo chorus, a ping-pong delay and
// a long generated hall reverb. This plays out of the Add On's web view, not through LUNA's mixer.

class NoirSynth {
  constructor() {
    this.ctx = null;
    this.voices = new Map(); // note -> voice
    this.p = NoirLogic.preset('Rainfall Pad');
    this.filterPos = this.p.cutoff;
    this.lastNote = null;
  }

  /** Create the audio graph; call from a user gesture (autoplay rules). */
  async start() {
    if (this.ctx) {
      if (this.ctx.state !== 'running') await this.ctx.resume();
      return;
    }
    const ctx = (this.ctx = new (window.AudioContext || window.webkitAudioContext)());
    this.master = ctx.createGain();
    this.master.gain.value = 0.5;

    // Dry bus -> chorus -> (dry, delay, reverb) -> compressor -> out
    this.bus = ctx.createGain();
    this.bus.gain.value = 0.35;

    // Chorus: two modulated short delays, panned apart (the "ensemble" width of 80s polys).
    const merger = ctx.createChannelMerger(2);
    this.chorusOut = ctx.createGain();
    [0, 1].forEach((ch) => {
      const d = ctx.createDelay(0.05);
      d.delayTime.value = 0.012 + ch * 0.006;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.35 + ch * 0.13;
      const amt = ctx.createGain();
      amt.gain.value = 0.0035;
      lfo.connect(amt).connect(d.delayTime);
      lfo.start();
      this.bus.connect(d);
      d.connect(merger, 0, ch);
    });
    merger.connect(this.chorusOut);
    this.bus.connect(this.chorusOut);

    // Ping-pong delay, dotted eighth feel, darkened repeats.
    this.delayL = ctx.createDelay(2);
    this.delayR = ctx.createDelay(2);
    this.delayFb = ctx.createGain();
    this.delayTone = ctx.createBiquadFilter();
    this.delayTone.type = 'lowpass';
    this.delayTone.frequency.value = 3200;
    this.delaySend = ctx.createGain();
    const pp = ctx.createChannelMerger(2);
    this.chorusOut.connect(this.delaySend).connect(this.delayL);
    this.delayL.connect(this.delayR);
    this.delayR.connect(this.delayTone).connect(this.delayFb).connect(this.delayL);
    this.delayL.connect(pp, 0, 0);
    this.delayR.connect(pp, 0, 1);
    this.delayFb.gain.value = 0.45;

    // Hall reverb from a generated decaying-noise impulse (6 s, slightly darker tail).
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.impulse(6, 2.6);
    this.reverbSend = ctx.createGain();
    this.chorusOut.connect(this.reverbSend).connect(this.reverb);
    pp.connect(this.reverb);

    // Compressor: the Noir Synth plug-in's own (an audio worklet, below). The browser's built-in
    // DynamicsCompressor clamps every note's onset by ~6 dB and lets go over ~100 ms, an audible
    // swell the plug-in doesn't have. Until the worklet has loaded (and wherever worklets are
    // unavailable) the built-in one stands in, so notes always play.
    this.compIn = ctx.createGain();
    this.chorusOut.connect(this.compIn);
    pp.connect(this.compIn);
    this.reverb.connect(this.compIn);
    this.master.connect(ctx.destination);
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -14;
    this.comp.ratio.value = 3;
    this.compIn.connect(this.comp).connect(this.master);
    this.compReady = this.useNoirCompressor();

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.master.connect(this.analyser);

    this.apply(this.p);
  }

  /** Swap the built-in compressor for the plug-in's. Resolves true once it's in the signal path. */
  async useNoirCompressor() {
    const ctx = this.ctx;
    try {
      if (!ctx.audioWorklet || typeof AudioWorkletNode === 'undefined') return false;
      const url = URL.createObjectURL(new Blob([NOIR_COMPRESSOR_WORKLET], { type: 'application/javascript' }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      const node = new AudioWorkletNode(ctx, 'noir-compressor', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit',
      });
      this.compIn.disconnect();
      this.comp.disconnect();
      this.compIn.connect(node).connect(this.master);
      this.comp = node;
      return true;
    } catch (e) {
      console.warn('Noir Synth: using the built-in compressor', e);
      return false;
    }
  }

  impulse(seconds, decay) {
    const rate = this.ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = this.ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        lp += 0.35 * ((Math.random() * 2 - 1) - lp); // gentle low-pass: darker tail
        d[i] = lp * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  get time() {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  /** Apply parameter changes (any subset). */
  apply(params) {
    Object.assign(this.p, params);
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.delaySend.gain.setTargetAtTime(this.p.delay * 0.6, t, 0.05);
    this.reverbSend.gain.setTargetAtTime(this.p.reverb * 0.9, t, 0.05);
    for (const v of this.voices.values()) this.updateVoiceFilter(v, t);
  }

  setTempo(bpm) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.delayL.delayTime.setTargetAtTime((60 / bpm) * 0.75, t, 0.05);
    this.delayR.delayTime.setTargetAtTime((60 / bpm) * 0.75, t, 0.05);
  }

  /** The sweep: 0..1 filter position, applied to every sounding voice. */
  setFilterPosition(pos) {
    this.filterPos = pos;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    for (const v of this.voices.values()) this.updateVoiceFilter(v, t);
  }

  /**
   * The cutoff is the sum of two separate controls, as in the Noir Synth plug-in:
   *   base (the swept position, in Hz) + envelope shape (0..1) x (peak - base).
   * The sweep only moves `base` and the envelope's depth, never the envelope itself, so the
   * 30-a-second sweep updates can no longer cut into a note's filter envelope.
   */
  updateVoiceFilter(v, t) {
    const base = NoirLogic.cutoffHz(this.filterPos);
    const peak = NoirLogic.cutoffHz(Math.min(1, this.filterPos + v.envAmount));
    const q = 0.7 + this.p.resonance * 14;
    v.base.offset.setTargetAtTime(base, t, 0.03);
    v.envDepth.gain.setTargetAtTime(peak - base, t, 0.03);
    for (const f of v.filters) f.Q.setTargetAtTime(q, t, 0.05);
  }

  noteOn(note, velocity = 100, when = 0) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = Math.max(when || ctx.currentTime, ctx.currentTime);
    if (this.voices.has(note)) this.release(this.voices.get(note), t);
    if (this.voices.size >= 8) {
      const [oldest] = this.voices.keys();
      this.release(this.voices.get(oldest), t);
      this.voices.delete(oldest);
    }
    const p = this.p;
    const hz = 440 * Math.pow(2, (note - 69) / 12);
    const fromHz = this.lastNote != null && p.glide > 0 ? 440 * Math.pow(2, (this.lastNote - 69) / 12) : hz;
    this.lastNote = note;

    const out = ctx.createGain();
    out.gain.value = 0;
    const filters = [ctx.createBiquadFilter(), ctx.createBiquadFilter()];
    filters.forEach((f) => (f.type = 'lowpass'));
    filters[0].connect(filters[1]).connect(out).connect(this.bus);

    const oscs = [];
    const mk = (type, mult, detuneCents, level) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(fromHz * mult, t);
      if (fromHz !== hz) o.frequency.exponentialRampToValueAtTime(hz * mult, t + p.glide);
      o.detune.value = detuneCents;
      const g = ctx.createGain();
      g.gain.value = level;
      o.connect(g).connect(filters[0]);
      o.start(t);
      oscs.push(o);
    };
    mk(p.wave, 1, -p.detune, 0.5);
    mk(p.wave, 1, p.detune, 0.5);
    if (p.sub > 0) mk('square', 0.5, 0, p.sub * 0.6);

    // Filter: cutoff = base (swept) + envelope (0..1) x depth, summed on the filters' frequency.
    const base = NoirLogic.cutoffHz(this.filterPos);
    const peak = NoirLogic.cutoffHz(Math.min(1, this.filterPos + p.envAmount));
    const q = 0.7 + p.resonance * 14;
    const baseSrc = ctx.createConstantSource();
    baseSrc.offset.value = base;
    const env = ctx.createConstantSource();          // the envelope shape, 0..1
    const envAttack = Math.max(0.005, p.attack);
    env.offset.setValueAtTime(0, t);
    env.offset.linearRampToValueAtTime(1, t + envAttack);
    env.offset.setTargetAtTime(0, t + envAttack, Math.max(0.02, p.decay / 3));
    const envDepth = ctx.createGain();
    envDepth.gain.value = peak - base;
    env.connect(envDepth);
    for (const f of filters) {
      f.Q.value = q;
      f.frequency.value = 0;                         // driven entirely by the two sources
      baseSrc.connect(f.frequency);
      envDepth.connect(f.frequency);
    }
    baseSrc.start(t);
    env.start(t);
    oscs.push(baseSrc, env);                         // stopped with the voice

    const vel = 0.35 + 0.65 * (velocity / 127);
    const g = out.gain;
    g.setValueAtTime(0, t);
    g.linearRampToValueAtTime(vel, t + Math.max(0.003, p.attack));
    g.setTargetAtTime(vel * p.sustain, t + p.attack, Math.max(0.02, p.decay / 3));

    const voice = { note, out, oscs, filters, base: baseSrc, envDepth, envAmount: p.envAmount };
    this.voices.set(note, voice);
    return voice;
  }

  noteOff(note, when = 0) {
    const v = this.voices.get(note);
    if (!v || !this.ctx) return;
    const t = Math.max(when || this.ctx.currentTime, this.ctx.currentTime);
    this.release(v, t);
    // A scheduled (arp) note stays in the table until it ends, so the sweep keeps reaching it.
    const drop = () => this.voices.get(note) === v && this.voices.delete(note);
    const ms = (t - this.ctx.currentTime) * 1000;
    ms > 5 ? setTimeout(drop, ms) : drop();
  }

  release(v, t) {
    const r = Math.max(0.02, this.p.release);
    const g = v.out.gain;
    if (g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(t);
    else {
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
    }
    g.setTargetAtTime(0, t, r / 4);
    for (const o of v.oscs) o.stop(t + r * 1.5);
  }

  allOff() {
    for (const n of [...this.voices.keys()]) this.noteOff(n);
  }
}

/**
 * The Noir Synth plug-in's compressor (NoirEngine.h), sample for sample: stereo-linked peak detector,
 * threshold -14 dB, ratio 3, 30 dB soft knee, 3 ms attack, 250 ms release, automatic make-up gain.
 */
const NOIR_COMPRESSOR_WORKLET = `
const T = -14, R = 3, W = 30;
const curve = (x) => (x < T - W / 2 ? x : x > T + W / 2 ? T + (x - T) / R : x + (1 / R - 1) * (x - T + W / 2) ** 2 / (2 * W));
class NoirCompressor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.gr = 0;
    this.attack = Math.exp(-1 / (0.003 * sampleRate));
    this.release = Math.exp(-1 / (0.25 * sampleRate));
    this.makeup = Math.pow(10, (-0.6 * curve(0)) / 20);
  }
  process(inputs, outputs) {
    const input = inputs[0], output = outputs[0];
    const n = output[0].length;
    if (!input || !input.length) { for (const ch of output) ch.fill(0); return true; }
    const L = input[0], Rin = input[1] || input[0], oL = output[0], oR = output[1] || output[0];
    for (let i = 0; i < n; i++) {
      const peak = Math.max(Math.abs(L[i]), Math.abs(Rin[i]));
      const inDb = peak > 1e-6 ? 20 * Math.log10(peak) : -120;
      const gr = inDb - curve(inDb);
      this.gr = gr + (this.gr - gr) * (gr > this.gr ? this.attack : this.release);
      const g = Math.pow(10, -this.gr / 20) * this.makeup;
      oL[i] = L[i] * g;
      oR[i] = Rin[i] * g;
    }
    return true;
  }
}
registerProcessor('noir-compressor', NoirCompressor);
`;

globalThis.NoirSynth = NoirSynth;
