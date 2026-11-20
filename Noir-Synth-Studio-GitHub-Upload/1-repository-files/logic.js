// Noir Synth Studio: logic with no DOM and no Web Audio, so the tests exercise it against
// Luna.MockEngine. A web port of the Noir Synth instrument plug-in (~/luna-add-ons/noir-synth-plugin):
// the same presets, arpeggiator, sweep, chords, 20 film progressions with voice leading, and
// factory programs, number for number.
//
// - NoirLogic: presets, arpeggiator, sweep shapes, cutoff mapping (from the original Add On).
// - NoirChords: key / scale chords, chord names, the 20 progressions and voice leading.
// - NoirPrograms: the 25 factory programs (5 Signature + 20 Film).
// - ChordEngine: one key in, a chord (or a progression step) out; refcounted, strummed.
// - LunaOut: plays notes into the selected LUNA track, sends the sweep as CC 74 + "Cutoff".

const ARP_MODES = ['up', 'down', 'updown', 'random', 'played'];
const ARP_RATES = { '1/4': 1, '1/8': 0.5, '1/8T': 1 / 3, '1/16': 0.25, '1/32': 0.125 };
const SWEEP_SHAPES = ['off', 'lfo', 'rise', 'fall'];

/** The Signature sounds: the synth's own parameters. */
const PRESETS = {
  'Rainfall Pad': {
    wave: 'sawtooth', detune: 14, sub: 0.25, cutoff: 0.32, resonance: 0.35, envAmount: 0.25,
    attack: 1.8, decay: 1.5, sustain: 0.85, release: 4.5, glide: 0,
    sweep: 'lfo', sweepRate: 0.06, sweepDepth: 0.35, delay: 0.25, reverb: 0.75,
    arp: false, arpMode: 'up', arpRate: '1/8', arpOctaves: 1, arpGate: 0.6,
  },
  'Neon Brass': {
    wave: 'sawtooth', detune: 9, sub: 0.15, cutoff: 0.18, resonance: 0.2, envAmount: 0.6,
    attack: 0.35, decay: 1.2, sustain: 0.7, release: 2.2, glide: 0,
    sweep: 'rise', sweepRate: 0.25, sweepDepth: 0.55, delay: 0.15, reverb: 0.65,
    arp: false, arpMode: 'up', arpRate: '1/8', arpOctaves: 1, arpGate: 0.6,
  },
  'Night City Arp': {
    wave: 'sawtooth', detune: 6, sub: 0.3, cutoff: 0.22, resonance: 0.6, envAmount: 0.45,
    attack: 0.005, decay: 0.22, sustain: 0.2, release: 0.35, glide: 0,
    sweep: 'lfo', sweepRate: 0.04, sweepDepth: 0.5, delay: 0.4, reverb: 0.5,
    arp: true, arpMode: 'updown', arpRate: '1/16', arpOctaves: 2, arpGate: 0.5,
  },
  'Off-World Bells': {
    wave: 'square', detune: 4, sub: 0, cutoff: 0.55, resonance: 0.3, envAmount: 0.3,
    attack: 0.002, decay: 1.6, sustain: 0.0, release: 3.0, glide: 0,
    sweep: 'fall', sweepRate: 0.3, sweepDepth: 0.3, delay: 0.45, reverb: 0.8,
    arp: true, arpMode: 'random', arpRate: '1/8', arpOctaves: 2, arpGate: 0.4,
  },
  'Spinner Lead': {
    wave: 'sawtooth', detune: 18, sub: 0.2, cutoff: 0.4, resonance: 0.45, envAmount: 0.35,
    attack: 0.08, decay: 0.8, sustain: 0.8, release: 1.6, glide: 0.12,
    sweep: 'lfo', sweepRate: 0.15, sweepDepth: 0.25, delay: 0.35, reverb: 0.6,
    arp: false, arpMode: 'up', arpRate: '1/8', arpOctaves: 1, arpGate: 0.6,
  },
};

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const mod12 = (a) => ((a % 12) + 12) % 12;

const NoirLogic = {
  ARP_MODES,
  ARP_RATES,
  SWEEP_SHAPES,
  PRESETS,

  preset(name) {
    const p = PRESETS[name];
    return p ? { ...p } : undefined;
  },

  arpSequence(held, mode = 'up', octaves = 1) {
    if (!held.length) return [];
    const base = mode === 'played' ? [...held] : [...new Set(held)].sort((a, b) => a - b);
    const pool = [];
    for (let o = 0; o < Math.max(1, octaves); o++) {
      for (const n of base) if (n + 12 * o <= 127) pool.push(n + 12 * o);
    }
    if (mode === 'down') return pool.reverse();
    if (mode === 'updown') return pool.length < 3 ? pool : [...pool, ...pool.slice(1, -1).reverse()];
    return pool;
  },

  arpNote(sequence, mode, i, rand = Math.random) {
    if (!sequence.length) return undefined;
    if (mode === 'random') return sequence[Math.floor(rand() * sequence.length)];
    return sequence[i % sequence.length];
  },

  stepSeconds(bpm, rate) {
    return (60 / bpm) * (ARP_RATES[rate] ?? 0.5);
  },

  sweepOffset(shape, t, rate, depth) {
    if (shape === 'lfo') return depth * Math.sin(2 * Math.PI * rate * t);
    if (shape === 'rise' || shape === 'fall') {
      const p = clamp01(t * rate);
      const eased = 1 - Math.pow(1 - p, 2);
      return shape === 'rise' ? depth * (eased * 2 - 1) : depth * (1 - eased * 2);
    }
    return 0;
  },

  filterPosition(cutoff, shape, t, rate, depth) {
    return clamp01(cutoff + NoirLogic.sweepOffset(shape, t, rate, depth));
  },

  cutoffHz(position) {
    return 40 * Math.pow(400, clamp01(position));
  },

  ccValue(position) {
    return Math.round(clamp01(position) * 127);
  },

  instrumentSlot(track) {
    const items = track?.effects?.items ?? [];
    return items.find((s) => s.insertType?.value === 'instrument' && !s.isEmpty);
  },

  cutoffParam(slot) {
    const params = slot?.params ?? [];
    const named = (re) => params.find((p) => re.test(p.name.value ?? ''));
    return named(/cut ?off/i) ?? named(/\b(vcf|filter) ?(freq|frequency)\b/i) ?? named(/^(vcf|filter)$/i);
  },

  /** Tempo for timing: LUNA's at the playhead when known, else the window's own BPM. */
  tempo(session, fallback) {
    const t = session?.transport?.tempo?.value;
    return typeof t === 'number' && t > 0 ? t : fallback;
  },

  /**
   * Seconds until the next chord-length boundary while LUNA plays, from the playhead's
   * bar|beat (bars of `beatsPerBar` beats). Undefined when LUNA isn't playing or has no position.
   */
  secondsToBoundary(barBeat, playing, bpm, chordBeats, beatsPerBar = 4, ticksPerBeat = 960) {
    if (!playing || !barBeat || !(bpm > 0)) return undefined;
    const beatInBar = (barBeat.beat ?? 1) - 1 + (barBeat.tick ?? 0) / ticksPerBeat;
    const beatsFromBar1 = ((barBeat.bar ?? 1) - 1) * beatsPerBar + beatInBar;
    const into = beatsFromBar1 % chordBeats;
    const left = into < 1e-6 ? 0 : chordBeats - into;
    return (left * 60) / bpm;
  },
};

// ============================================================================  chords

const KEY_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const SCALES = {
  Major: [0, 2, 4, 5, 7, 9, 11],
  Minor: [0, 2, 3, 5, 7, 8, 10],
  Dorian: [0, 2, 3, 5, 7, 9, 10],
  Phrygian: [0, 1, 3, 5, 7, 8, 10],
  Mixolydian: [0, 2, 4, 5, 7, 9, 10],
  'Harmonic Minor': [0, 2, 3, 5, 7, 8, 11],
};
const CHORD_TYPES = ['Triad', '7th', '9th', 'Sus2', 'Sus4', 'Power'];
const VOICINGS = ['Close', 'Open', 'Wide'];
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
const WHITE = [0, 2, 4, 5, 7, 9, 11];
const floorDiv = (a, b) => Math.floor(a / b);

/** Chord section settings, with the plug-in's defaults (A minor 7ths). */
const DEFAULT_CHORDS = {
  chords: false, key: 9, scale: 'Minor', type: '7th', voicing: 'Close', inversion: 0, strum: 0,
  bass: false, map: 'Scale', progression: -1, play: 'Auto', length: '1 bar',
};

const deg = (s, k) => {
  const sc = SCALES[s.scale] ?? SCALES.Minor;
  return sc[k % 7] + 12 * Math.floor(k / 7);
};

function voicePost(c, voicing) {
  if (voicing !== 'Close' && c.length >= 3) {
    if (c.length === 3) c[1] += 12;
    else c[c.length - 2] -= 12;
    c.sort((a, b) => a - b);
    if (voicing === 'Wide') c[c.length - 1] += 12;
  }
  return c;
}

const uniqueInRange = (notes) => [...new Set(notes.filter((n) => n >= 0 && n <= 127))];

// Progression chord shapes.
const MAJ = [0, 4, 7], MIN = [0, 3, 7], SUS2 = [0, 2, 7], MAJ7 = [0, 4, 7, 11], MIN7 = [0, 3, 7, 10],
  DOM7 = [0, 4, 7, 10], MADD9 = [0, 3, 7, 14], MIN6 = [0, 3, 7, 9], MMAJ7 = [0, 3, 7, 11];
const ch = (offset, iv, suffix) => ({ offset, iv, suffix });
const maj = (o) => ch(o, MAJ, ''), min = (o) => ch(o, MIN, 'm'), sus2 = (o) => ch(o, SUS2, 'sus2');
const maj7 = (o) => ch(o, MAJ7, 'maj7'), min7 = (o) => ch(o, MIN7, 'm7'), dom7 = (o) => ch(o, DOM7, '7');

const PROGRESSIONS = [
  { name: 'Hold The Line', roman: 'i - bVI - bIII - bVII', chords: [min(0), maj(8), maj(3), maj(10)] },
  { name: 'Dream Within', roman: 'i - v - bVII - IV', chords: [min(0), min(7), maj(10), maj(5)] },
  { name: 'Cathedral Orbit', roman: 'i - bVI7 - bIII - v', chords: [min(0), maj7(8), maj(3), min(7)] },
  { name: 'Gotham Pulse', roman: 'i - bVI', chords: [min(0), maj(8)] },
  { name: 'Lydian Wonder', roman: 'Imaj7 - II - iii - II', chords: [maj7(0), maj(2), min(4), maj(2)] },
  { name: 'Mediant Fanfare', roman: 'I - bVI - bVII - I', chords: [maj(0), maj(8), maj(10), maj(0)] },
  { name: 'Frontier', roman: 'I - bVII - IV - I', chords: [maj(0), maj(10), maj(5), maj(0)] },
  { name: 'Rainlight', roman: 'i(add9) - bVImaj7 - bIII - bVIIsus2', chords: [ch(0, MADD9, 'm(add9)'), maj7(8), maj(3), sus2(10)] },
  { name: 'Elegy', roman: 'i - iv - i - V', chords: [min(0), min(5), min(0), maj(7)] },
  { name: 'Ascension', roman: 'I - V - vi - IV', chords: [maj(0), maj(7), min(9), maj(5)] },
  { name: 'Hearth & Home', roman: 'I - IV - iv - I', chords: [maj(0), maj(5), min(5), maj(0)] },
  { name: 'Titan March', roman: 'I - bVII - bVI - bVII', chords: [maj(0), maj(10), maj(8), maj(10)] },
  { name: 'Phrygian Threat', roman: 'i - bII', chords: [min(0), maj(1)] },
  { name: 'Desert Dorian', roman: 'i(add9) - IV - i - bVII', chords: [ch(0, MADD9, 'm(add9)'), maj(5), min(0), maj(10)] },
  { name: 'Royal Road', roman: 'IVmaj7 - V7 - iii7 - vi', chords: [maj7(5), dom7(7), min7(4), min(9)] },
  // Root position, so the line A - G# - G - F# stays the top voice.
  { name: 'Descent Line', roman: 'i - i(maj7) - i7 - i6', rootPosition: true,
    chords: [ch(0, [0, 3, 7, 12], 'm'), ch(0, MMAJ7, 'm(maj7)'), min7(0), ch(0, MIN6, 'm6')] },
  { name: 'Pulse Ascend', roman: 'i - bIII - bVII - IV', chords: [min(0), maj(3), maj(10), maj(5)] },
  { name: 'Last Stand', roman: 'i - bVII - bVI - V', chords: [min(0), maj(10), maj(8), maj(7)] },
  { name: "Wizard's Stair", roman: 'i - VI - iv - V7', chords: [min(0), maj(8), min(5), dom7(7)] },
  { name: 'Fog Drone', roman: 'Isus2 - bVIIsus2 - bVIsus2 - bVIIsus2', chords: [sus2(0), sus2(10), sus2(8), sus2(10)] },
];

const NoirChords = {
  KEY_NAMES, SCALES, CHORD_TYPES, VOICINGS, ROMAN, PROGRESSIONS, DEFAULT_CHORDS,
  LENGTHS: { '1/2 bar': 0.5, '1 bar': 1, '2 bars': 2 },

  /** The scale degree (0..6) and its root note for a played key. */
  degreeFor(s, note) {
    const sc = SCALES[s.scale] ?? SCALES.Minor;
    if (s.map === 'White keys') {
      const pc = mod12(note);
      let d = 0;
      for (let i = 0; i < 7; i++) if (WHITE[i] <= pc) d = i;
      let root = 12 * floorDiv(note, 12) + s.key + sc[d];
      if (s.key >= 6) root -= 12;
      return [d, root];
    }
    const rel = note - s.key;
    const pc = mod12(rel);
    let d = 0;
    for (let i = 0; i < 7; i++) if (sc[i] <= pc) d = i;
    return [d, s.key + 12 * floorDiv(rel, 12) + sc[d]];
  },

  /** Diatonic chord for one key: stacked in the scale, inverted, voiced, optional bass. */
  chordFor(s, note) {
    const [d, root] = NoirChords.degreeFor(s, note);
    const steps = { Triad: [0, 2, 4], '7th': [0, 2, 4, 6], '9th': [0, 2, 4, 6, 8], Sus2: [0, 1, 4], Sus4: [0, 3, 4], Power: [0, 4, 7] }[s.type] ?? [0, 2, 4];
    const base = deg(s, d);
    let c = steps.map((st) => root + deg(s, d + st) - base).sort((a, b) => a - b);
    for (let i = 0; i < Math.min(3, Math.max(0, s.inversion)); i++) c.push(c.shift() + 12);
    c = voicePost(c, s.voicing);
    if (s.bass) c.unshift(root - 12);
    return uniqueInRange(c);
  },

  /** Chord symbol for scale degree `d` ("Am7", "Bm7b5", "Cmaj7", "Em7(b9)"...). */
  chordName(s, d) {
    const name = KEY_NAMES[mod12(s.key + deg(s, d))];
    const iv = (st) => deg(s, d + st) - deg(s, d);
    const third = iv(2), fifth = iv(4), seventh = iv(6);
    if (s.type === 'Power') return name + '5';
    if (s.type === 'Sus2') return name + 'sus2' + (fifth === 6 ? '(b5)' : '');
    if (s.type === 'Sus4') return name + 'sus4' + (fifth === 6 ? '(b5)' : '');
    const minor = third === 3, dim = minor && fifth === 6, aug = !minor && fifth === 8;
    if (s.type === 'Triad') return name + (dim ? 'dim' : aug ? 'aug' : minor ? 'm' : '');
    const flat9 = s.type === '9th' && iv(8) === 13;
    const ext = s.type === '9th' && !flat9 ? '9' : '7';
    let sym;
    if (dim) sym = seventh === 9 ? 'dim' + ext : 'm' + ext + 'b5';
    else if (aug) sym = seventh === 11 ? 'maj' + ext + '#5' : 'aug' + ext;
    else if (minor) sym = seventh === 11 ? 'm(maj' + ext + ')' : 'm' + ext;
    else sym = seventh === 11 ? 'maj' + ext : ext;
    return name + sym + (flat9 ? '(b9)' : '');
  },

  /** The key a tile plays for degree `d` in diatonic mode. */
  padNote(s, d) {
    return s.map === 'White keys' ? 60 + WHITE[d] : 48 + s.key + deg(s, d);
  },

  progressionChordName(chord, keyPc) {
    return KEY_NAMES[mod12(keyPc + chord.offset)] + chord.suffix;
  },

  /** Voice-led notes: the inversion whose average sits nearest `centre`, then voicing and bass. */
  voiceLed(chord, root, centre, voicing = 'Close', bass = false, rootPosition = false) {
    const tones = chord.iv.map((i) => root + i);
    const n = tones.length;
    let best = null;
    let bestScore = Infinity;
    for (let k = 0; k < (rootPosition ? 1 : n); k++) {
      const stack = [];
      for (let j = 0; j < n; j++) {
        let t = tones[(k + j) % n];
        if (stack.length) while (t <= stack[stack.length - 1]) t += 12;
        stack.push(t);
      }
      const mean = stack.reduce((a, b) => a + b, 0) / n;
      const shift = 12 * Math.round((centre - mean) / 12);
      const shifted = stack.map((t) => t + shift);
      const score = Math.abs(mean + shift - centre) + 0.15 * (shifted[n - 1] - shifted[0]);
      if (score < bestScore) { bestScore = score; best = shifted; }
    }
    voicePost(best, voicing);
    if (bass && best.length) {
      let b = best[0] - 1;
      while (mod12(b) !== mod12(root)) b--;
      if (best[0] - b < 7) b -= 12;
      best.unshift(b);
    }
    return uniqueInRange(best);
  },

  /** White-key index 0..6 (C..B) of a note; black keys snap down. */
  whiteIndex(note) {
    return [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6][mod12(note)];
  },
};

// ============================================================================  programs

const P = (name, wave, detune, sub, cutoff, resonance, envAmount, attack, decay, sustain, release, glide,
  sweep, sweepRate, sweepDepth, delay, reverb, arp, arpMode, arpRate, arpOctaves, arpGate) =>
  ({ name, wave, detune, sub, cutoff, resonance, envAmount, attack, decay, sustain, release, glide,
     sweep, sweepRate, sweepDepth, delay, reverb, arp, arpMode, arpRate, arpOctaves, arpGate });

const SIGNATURE_TEXT = {
  'Rainfall Pad': 'Slow detuned saws under a drifting filter. The sound of a wet street at 3am.',
  'Neon Brass': 'Swelling poly brass that opens as you hold it.',
  'Night City Arp': 'A 16th-note up/down arpeggio with a slow filter tide.',
  'Off-World Bells': 'Glassy square bells, scattered by a random arp.',
  'Spinner Lead': 'A detuned lead with glide, for the melody over everything else.',
};

const S = 'sawtooth', Q = 'square', T = 'triangle';
const film = (patch, description, progression, key, voicing, bass, strum, length) =>
  ({ patch, category: 'Film', description, chords: { chords: true, progression, key, voicing, bass, strum, play: 'Auto', length } });

const PROGRAMS = [
  ...Object.entries(PRESETS).map(([name, p]) => ({ patch: { name, ...p }, category: 'Signature', description: SIGNATURE_TEXT[name], chords: null })),
  film(P('Hold The Line', S, 12, 0.35, 0.30, 0.25, 0.45, 0.25, 1.2, 0.75, 2.0, 0, 'rise', 0.12, 0.40, 0.20, 0.70, false, 'up', '1/8', 1, 0.6),
    'Big minor brass climbing through i - bVI - bIII - bVII. Hold one key; the chords follow the bar.', 0, 9, 'Open', true, 0, '1 bar'),
  film(P('Dream Within', S, 16, 0.20, 0.26, 0.20, 0.20, 1.6, 2.0, 0.90, 4.5, 0, 'lfo', 0.05, 0.30, 0.15, 0.85, false, 'up', '1/8', 1, 0.6),
    'Slow-blooming strings pad on a patient four-chord loop, two bars per chord.', 1, 9, 'Close', true, 0, '2 bars'),
  film(P('Cathedral Orbit', Q, 3, 0.30, 0.62, 0.10, 0.05, 0.04, 1.0, 1.00, 3.5, 0, 'off', 0.05, 0.00, 0.30, 0.90, true, 'up', '1/8', 2, 0.55),
    'Pipe-organ pulses: a steady 8th-note figure over held minor chords in a vast room.', 2, 9, 'Close', true, 0, '1 bar'),
  film(P('Gotham Pulse', S, 8, 0.45, 0.20, 0.45, 0.50, 0.005, 0.25, 0.30, 0.4, 0, 'rise', 0.10, 0.45, 0.25, 0.55, true, 'up', '1/16', 1, 0.45),
    'Two dark chords and a relentless 16th-note pulse that slowly brightens.', 3, 2, 'Close', true, 0, '2 bars'),
  film(P('Lydian Wonder', T, 7, 0.10, 0.60, 0.15, 0.25, 0.30, 1.5, 0.70, 3.0, 0, 'lfo', 0.08, 0.15, 0.35, 0.80, false, 'up', '1/8', 1, 0.6),
    'Bright, wide and strummed: the raised fourth that sounds like flying.', 4, 0, 'Wide', true, 45, '1 bar'),
  film(P('Mediant Fanfare', S, 10, 0.25, 0.20, 0.20, 0.65, 0.18, 1.0, 0.70, 1.8, 0, 'rise', 0.30, 0.40, 0.15, 0.65, false, 'up', '1/8', 1, 0.6),
    'Heroic brass leaping between major chords a third apart.', 5, 0, 'Open', true, 0, '1 bar'),
  film(P('Frontier', S, 6, 0.20, 0.35, 0.15, 0.35, 0.12, 1.2, 0.70, 2.2, 0, 'lfo', 0.07, 0.20, 0.30, 0.60, false, 'up', '1/8', 1, 0.6),
    'Open-sky major chords with a flattened seventh: wide plains, long horizon.', 6, 2, 'Open', true, 20, '1 bar'),
  film(P('Rainlight', S, 18, 0.15, 0.30, 0.55, 0.50, 0.90, 2.0, 0.75, 5.0, 0.08, 'lfo', 0.07, 0.30, 0.40, 0.90, false, 'up', '1/8', 1, 0.6),
    'Resonant 80s poly brass, slow swells, neon reflected in puddles.', 7, 2, 'Close', true, 0, '2 bars'),
  film(P('Elegy', S, 14, 0.10, 0.25, 0.10, 0.15, 1.4, 2.0, 0.85, 4.0, 0, 'lfo', 0.04, 0.20, 0.10, 0.85, false, 'up', '1/8', 1, 0.6),
    'A lament in harmonic minor; the major V aches back to i.', 8, 9, 'Open', true, 0, '1 bar'),
  film(P('Ascension', S, 12, 0.20, 0.40, 0.30, 0.30, 0.01, 0.5, 0.50, 1.2, 0, 'rise', 0.08, 0.40, 0.40, 0.70, true, 'updown', '1/8', 2, 0.6),
    'The uplifting four-chord loop, arpeggiated and rising as it goes.', 9, 0, 'Close', true, 0, '1 bar'),
  film(P('Hearth & Home', T, 5, 0.15, 0.45, 0.10, 0.20, 0.50, 1.5, 0.80, 3.0, 0, 'lfo', 0.05, 0.10, 0.20, 0.75, false, 'up', '1/8', 1, 0.6),
    'Warm and pastoral, with the borrowed minor iv that tugs at the heart.', 10, 0, 'Open', true, 30, '1 bar'),
  film(P('Titan March', S, 9, 0.40, 0.22, 0.25, 0.70, 0.08, 0.9, 0.65, 1.5, 0, 'rise', 0.25, 0.35, 0.20, 0.60, false, 'up', '1/8', 1, 0.6),
    'Superhero brass: bVII and bVI march back and forth, half a bar each.', 11, 0, 'Open', true, 0, '1/2 bar'),
  film(P('Phrygian Threat', S, 20, 0.50, 0.14, 0.60, 0.35, 0.40, 1.5, 0.80, 2.5, 0, 'rise', 0.10, 0.50, 0.25, 0.60, false, 'up', '1/8', 1, 0.6),
    'A low growl rocking a half step up and back. Something is coming.', 12, 4, 'Close', true, 0, '1 bar'),
  film(P('Desert Dorian', Q, 10, 0.30, 0.30, 0.35, 0.30, 0.60, 1.8, 0.70, 3.5, 0, 'lfo', 0.03, 0.35, 0.50, 0.75, false, 'up', '1/8', 1, 0.6),
    'Dorian heat haze: minor with a bright major IV, long echoes across sand.', 13, 2, 'Open', true, 0, '2 bars'),
  film(P('Royal Road', T, 4, 0.00, 0.65, 0.10, 0.30, 0.005, 1.4, 0.25, 1.8, 0, 'off', 0.05, 0.00, 0.25, 0.60, false, 'up', '1/8', 1, 0.6),
    'Bittersweet piano-like chords, gently strummed, on the classic IV - V - iii - vi.', 14, 0, 'Close', true, 25, '1 bar'),
  film(P('Descent Line', S, 7, 0.20, 0.28, 0.30, 0.25, 0.20, 1.2, 0.70, 2.0, 0, 'lfo', 0.06, 0.15, 0.45, 0.55, false, 'up', '1/8', 1, 0.6),
    'The spy-thriller line: one minor chord with a voice sliding down inside it.', 15, 9, 'Close', true, 0, '1 bar'),
  film(P('Pulse Ascend', S, 8, 0.35, 0.24, 0.50, 0.40, 0.005, 0.2, 0.25, 0.3, 0, 'rise', 0.06, 0.50, 0.30, 0.55, true, 'up', '1/16', 2, 0.5),
    'Driving 16ths climbing through i - bIII - bVII - IV as the filter rises.', 16, 9, 'Close', true, 0, '1 bar'),
  film(P('Last Stand', S, 12, 0.35, 0.26, 0.30, 0.60, 0.10, 1.0, 0.75, 2.0, 0, 'rise', 0.20, 0.40, 0.20, 0.70, false, 'up', '1/8', 1, 0.6),
    'The descending epic cadence, i - bVII - bVI - V, in full brass.', 17, 9, 'Open', true, 0, '1 bar'),
  film(P("Wizard's Stair", Q, 2, 0.00, 0.60, 0.25, 0.35, 0.002, 1.2, 0.00, 2.5, 0, 'fall', 0.20, 0.20, 0.45, 0.80, true, 'updown', '1/8T', 2, 0.45),
    'Celesta-like bells tumbling in triplets over a minor turnaround.', 18, 4, 'Close', false, 0, '1 bar'),
  film(P('Fog Drone', S, 22, 0.30, 0.18, 0.30, 0.10, 2.5, 3.0, 0.90, 6.0, 0, 'lfo', 0.03, 0.30, 0.30, 1.00, false, 'up', '1/8', 1, 0.6),
    'Suspended chords sliding in parallel through thick fog. No resolution.', 19, 0, 'Wide', true, 0, '2 bars'),
];

const NoirPrograms = {
  PROGRAMS,
  /** A program's patch as a fresh synth parameter object (never the shared one). */
  patch(i) {
    const { name, ...p } = PROGRAMS[i].patch;
    return { ...p };
  },
  /** Chord settings after loading program `i` onto `current`: Film brings its progression; Signature plays plain notes. */
  chordSettings(i, current) {
    const c = PROGRAMS[i].chords;
    return c ? { ...current, ...c } : { ...current, chords: false, progression: -1 };
  },
};

// ============================================================================  chord engine

/**
 * One key in, a chord out. Notes are refcounted (two chords may share a note) and strummed.
 * `out.on(note, velocity)` / `out.off(note)` reach the synth (or the arp). `schedule(fn, seconds)`
 * returns a cancel function; tests pass a fake one.
 *
 * Slots: one per input key ('k60'), per tile ('p60'), and 'auto' for the Auto progression player.
 */
class ChordEngine {
  constructor(out, schedule = (fn, s) => { const id = setTimeout(fn, s * 1000); return () => clearTimeout(id); }) {
    this.out = out;
    this.schedule = schedule;
    this.settings = { ...DEFAULT_CHORDS };
    this.refs = new Map();
    this.slots = new Map();      // slot -> { notes: [], pending: [cancel], degree }
    this.autoInputs = [];
    this.auto = { active: false, root: 57, velocity: 100, step: 0 };
  }

  progression() {
    const i = this.settings.progression;
    return i >= 0 && i < PROGRESSIONS.length ? PROGRESSIONS[i] : undefined;
  }

  get autoMode() {
    return !!(this.settings.chords && this.progression() && this.settings.play === 'Auto');
  }

  /** Degrees / steps sounding now, for lighting the tiles. */
  active() {
    const set = new Set();
    for (const s of this.slots.values()) if (s.degree >= 0) set.add(s.degree);
    return set;
  }

  pressRef(note, velocity) {
    const n = (this.refs.get(note) ?? 0) + 1;
    this.refs.set(note, n);
    if (n === 1) this.out.on(note, velocity);
  }

  releaseRef(note) {
    const n = this.refs.get(note) ?? 0;
    if (n <= 0) return;
    if (n === 1) { this.refs.delete(note); this.out.off(note); } else this.refs.set(note, n - 1);
  }

  pressChord(slot, notes, velocity, degree) {
    const s = { notes: [], pending: [], degree };
    this.slots.set(slot, s);
    const strum = Math.max(0, this.settings.strum) / 1000;
    notes.forEach((note, k) => {
      if (k === 0 || strum === 0) { this.pressRef(note, velocity); s.notes.push(note); return; }
      s.pending.push(this.schedule(() => {
        if (this.slots.get(slot) !== s) return;
        this.pressRef(note, velocity);
        s.notes.push(note);
      }, k * strum));
    });
  }

  releaseSlot(slot) {
    const s = this.slots.get(slot);
    if (!s) return;
    this.slots.delete(slot);
    for (const cancel of s.pending) cancel();
    for (const note of s.notes) this.releaseRef(note);
  }

  /** A key (or tile, `pad: true`) goes down. Returns 'auto-start' when the Auto player should start. */
  inputOn(note, velocity = 100, { pad = false } = {}) {
    const st = this.settings;
    if (!st.chords) { this.pressRef(note, velocity); return 'note'; }
    const pr = this.progression();
    if (pr && !pad && st.play === 'Auto') {
      this.autoInputs = this.autoInputs.filter((n) => n !== note);
      this.autoInputs.push(note);
      this.auto.root = note;
      this.auto.velocity = velocity;
      if (!this.auto.active) {
        this.auto.active = true;
        this.auto.step = 0;
        return 'auto-start';
      }
      return 'auto';
    }
    const slot = (pad ? 'p' : 'k') + note;
    this.releaseSlot(slot);
    if (pr) {
      const step = NoirChords.whiteIndex(note) % pr.chords.length;
      let base = 12 * floorDiv(note, 12) + st.key;
      if (st.key >= 6) base -= 12;
      const c = pr.chords[step];
      this.pressChord(slot, NoirChords.voiceLed(c, base + c.offset, base + 7, st.voicing, st.bass, pr.rootPosition), velocity, step);
    } else {
      this.pressChord(slot, NoirChords.chordFor(st, note), velocity, NoirChords.degreeFor(st, note)[0]);
    }
    return 'chord';
  }

  inputOff(note, { pad = false } = {}) {
    if (!this.settings.chords) { this.releaseRef(note); return; }
    if (!pad) {
      const i = this.autoInputs.indexOf(note);
      if (i >= 0) {
        this.autoInputs.splice(i, 1);
        if (!this.autoInputs.length) this.stopAuto();
        else this.auto.root = this.autoInputs[this.autoInputs.length - 1];
        return;
      }
    }
    this.releaseSlot((pad ? 'p' : 'k') + note);
  }

  /** The Auto player's next chord: new chord in first, old one out, so the arp never stops. */
  fireAuto() {
    const pr = this.progression();
    if (!pr || !this.auto.active) { this.stopAuto(); return undefined; }
    const step = this.auto.step++ % pr.chords.length;
    const c = pr.chords[step];
    const st = this.settings;
    const notes = NoirChords.voiceLed(c, this.auto.root + c.offset, this.auto.root + 7, st.voicing, st.bass, pr.rootPosition);
    const old = this.slots.get('auto');
    this.slots.delete('auto');
    if (old) for (const cancel of old.pending) cancel();
    this.pressChord('auto', notes, this.auto.velocity, step);
    if (old) for (const note of old.notes) this.releaseRef(note);
    return { step, notes };
  }

  stopAuto() {
    this.auto.active = false;
    this.releaseSlot('auto');
  }

  /** Everything off: chords, pads, Auto. */
  allOff() {
    for (const slot of [...this.slots.keys()]) this.releaseSlot(slot);
    this.autoInputs = [];
    this.auto.active = false;
    for (const note of [...this.refs.keys()]) { this.refs.delete(note); this.out.off(note); }
  }
}

// ============================================================================  LUNA output

/**
 * Plays into a LUNA track. Notes go through Luna.SendMidi; the sweep goes as CC 74 and, if the
 * track's instrument has a cutoff-like parameter, as one continuous touched gesture on it.
 */
class LunaOut {
  constructor(luna) {
    this.midi = new Luna.SendMidi(luna);
    this.session = undefined;
    this.track = undefined;
    this.param = undefined;
    this.lastCc = -1;
    this.sounding = new Set();
  }

  async setTarget(session, track) {
    await this.allOff();
    this.session = session;
    this.track = track;
    this.param = undefined;
    this.lastCc = -1;
    if (!track) return;
    const slot = NoirLogic.instrumentSlot(track);
    if (slot) {
      await slot.controls.load();
      this.param = NoirLogic.cutoffParam(slot);
    }
  }

  get ready() {
    return !!(this.session && this.track);
  }

  get paramName() {
    return this.param?.name.value;
  }

  async noteOn(note, velocity = 100) {
    if (!this.ready) return;
    this.sounding.add(note);
    await this.midi.sendMidiNote(this.session.uid, this.track.id, note, velocity, true);
  }

  async noteOff(note) {
    if (!this.ready) return;
    this.sounding.delete(note);
    await this.midi.sendMidiNote(this.session.uid, this.track.id, note, 0, false);
  }

  async sweep(position) {
    if (!this.ready) return;
    const cc = NoirLogic.ccValue(position);
    if (cc === this.lastCc) return;
    this.lastCc = cc;
    await this.midi.sendController(this.session.uid, this.track.id, 74, cc);
    if (this.param) {
      if (!this.param.inGesture) this.param.begin();
      await this.param.normalized.set(position);
    }
  }

  endSweep() {
    if (this.param?.inGesture) this.param.end();
    this.lastCc = -1;
  }

  async allOff() {
    this.endSweep();
    if (!this.ready) return;
    for (const n of [...this.sounding]) await this.noteOff(n);
  }
}

globalThis.NoirLogic = NoirLogic;
globalThis.NoirChords = NoirChords;
globalThis.NoirPrograms = NoirPrograms;
globalThis.ChordEngine = ChordEngine;
globalThis.LunaOut = LunaOut;
