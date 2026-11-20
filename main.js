// Noir Synth Studio: DOM wiring. The Noir Synth instrument as a LUNA Add On: three pages (Perform,
// Sound, Chords), chord tiles and a keyboard over the light on water. Notes flow
//   keys / MIDI keyboard / tiles -> ChordEngine -> held notes + arpeggiator -> window synth and/or LUNA track,
// with the Auto progression player and the arp timed from LUNA's tempo (and its bars while it plays).
// Every LUNA listener is kept and released when the session or track changes.

const $ = (id) => document.getElementById(id);
const STORE = 'com.noirlab.noir_synth_studio:state';
const synth = new NoirSynth();
const light = new NoirLight($('light'));
const programs = NoirPrograms.PROGRAMS;
const C = NoirChords;

let luna;
let session;
let lunaOut;
let output = 'window';        // 'window' | 'luna' | 'both'
let program = 0;
let p = { ...NoirPrograms.patch(0), volume: 0.5, bpm: 92, latch: false };
const engine = new ChordEngine({ on: (n, v) => press(n, v), off: (n) => unpress(n) });
let programDefaults = { ...p };
const sessionReleases = [];
const trackReleases = [];
const releaseAll = (list) => { for (const u of list) u(); list.length = 0; };

// ============================================================================  parameters

const fmtTime = (v) => (v < 1 ? `${Math.round(v * 1000)} ms` : `${v.toFixed(2)} s`);
const fmtHz = (v) => { const hz = NoirLogic.cutoffHz(v); return hz >= 1000 ? `${(hz / 1000).toFixed(2)}k Hz` : `${Math.round(hz)} Hz`; };
const fmt2 = (v) => v.toFixed(2);

/** Every knob: range, curve and readout. `chord: true` lives in the chord engine's settings. */
const KNOBS = {
  detune: { min: 0, max: 40, fmt: (v) => `${v.toFixed(1)} ct` },
  sub: { min: 0, max: 1, fmt: fmt2 },
  glide: { min: 0, max: 0.6, fmt: fmtTime },
  cutoff: { min: 0, max: 1, fmt: fmtHz },
  resonance: { min: 0, max: 1, fmt: fmt2 },
  envAmount: { min: 0, max: 1, fmt: fmt2 },
  sweepRate: { min: 0.01, max: 2, log: true, fmt: (v) => `${v.toFixed(2)} Hz` },
  sweepDepth: { min: 0, max: 0.6, fmt: fmt2 },
  attack: { min: 0.002, max: 4, log: true, fmt: fmtTime },
  decay: { min: 0.02, max: 4, log: true, fmt: fmtTime },
  sustain: { min: 0, max: 1, fmt: fmt2 },
  release: { min: 0.02, max: 8, log: true, fmt: fmtTime },
  arpOctaves: { min: 1, max: 4, int: true, fmt: (v) => `${v}` },
  arpGate: { min: 0.1, max: 1, fmt: fmt2 },
  delay: { min: 0, max: 1, fmt: fmt2 },
  reverb: { min: 0, max: 1, fmt: fmt2 },
  volume: { min: 0, max: 1, fmt: fmt2 },
  bpm: { min: 50, max: 180, int: true, fmt: (v) => (lunaTempo() ? `${Math.round(lunaTempo())} LUNA` : `${v} BPM`) },
  inversion: { min: 0, max: 3, int: true, chord: true, fmt: (v) => `${v}` },
  strum: { min: 0, max: 200, int: true, chord: true, fmt: (v) => `${v} ms` },
};

const CHOICES = {
  wave: [['sawtooth', 'Saw'], ['square', 'Pulse'], ['triangle', 'Triangle']],
  sweep: [['off', 'Off'], ['lfo', 'Slow LFO'], ['rise', 'Rise'], ['fall', 'Fall']],
  arpMode: [['up', 'Up'], ['down', 'Down'], ['updown', 'Up/Down'], ['random', 'Random'], ['played', 'As played']],
  arpRate: Object.keys(NoirLogic.ARP_RATES).map((r) => [r, r]),
  key: C.KEY_NAMES.map((k, i) => [i, k]),
  scale: Object.keys(C.SCALES).map((s) => [s, s]),
  type: C.CHORD_TYPES.map((t) => [t, t]),
  voicing: C.VOICINGS.map((v) => [v, v]),
  map: [['Scale', 'Scale'], ['White keys', 'White keys']],
  progression: [[-1, 'Off'], ...C.PROGRESSIONS.map((pr, i) => [i, pr.name])],
  play: [['Keys', 'Keys'], ['Auto', 'Auto']],
  length: Object.keys(C.LENGTHS).map((l) => [l, l]),
};
const CHORD_IDS = new Set(['chords', 'key', 'scale', 'type', 'voicing', 'inversion', 'strum', 'bass', 'map', 'progression', 'play', 'length']);

const getParam = (id) => (CHORD_IDS.has(id) ? engine.settings[id] : p[id]);

function setParam(id, value) {
  if (CHORD_IDS.has(id)) {
    if (id === 'chords' || id === 'progression' || id === 'play') stopAllNotes();
    engine.settings[id] = value;
    renderChordState();
  } else {
    p[id] = value;
    if (id === 'volume') applyVolume();
    else if (id === 'bpm') synth.setTempo(currentTempo());
    else if (id === 'arp') { stopAllNotes(); }
    else if (id === 'latch' && !value) { latchSet = []; if (!held.length) stopArp(); }
    else synth.apply({ [id]: value });
    if (id === 'sweep') sweepStart = now();
  }
  for (const r of renderers.get(id) ?? []) r();
  save();
}

// ============================================================================  controls

const renderers = new Map();
const onRender = (id, fn) => { if (!renderers.has(id)) renderers.set(id, []); renderers.get(id).push(fn); fn(); };
const SVGNS = 'http://www.w3.org/2000/svg';

function arcPath(cx, cy, r, a0, a1) {
  const pt = (a) => [cx + r * Math.sin(a), cy - r * Math.cos(a)];
  const [x0, y0] = pt(a0), [x1, y1] = pt(a1);
  return `M ${x0} ${y0} A ${r} ${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${x1} ${y1}`;
}

const START = (-135 * Math.PI) / 180, END = (135 * Math.PI) / 180;
const norm = (k, v) => (k.log ? Math.log(v / k.min) / Math.log(k.max / k.min) : (v - k.min) / (k.max - k.min));
const denorm = (k, n) => { const v = k.log ? k.min * Math.pow(k.max / k.min, n) : k.min + n * (k.max - k.min); return k.int ? Math.round(v) : v; };

/** A thin-ring dial; drag up/down (Shift for fine), double-click resets to the program's value. */
function knob(page, id, label, x, y, { big = false } = {}) {
  const k = KNOBS[id];
  const size = big ? 170 : 60;
  const el = document.createElement('div');
  el.className = `ctl knob${big ? ' big' : ''}`;
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.style.width = `${big ? 190 : 72}px`;
  el.innerHTML = `<div class="cap caps">${label}</div>`;
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('viewBox', '0 0 100 100');
  const r = big ? 44 : 42, stroke = big ? 1.9 : 3.2;
  svg.innerHTML = `<circle class="disc" cx="50" cy="50" r="${r - stroke * 2.5}"/>
    <path class="track" stroke-width="${stroke}" d="${arcPath(50, 50, r, START, END)}"/>
    <path class="arc" stroke-width="${stroke + 0.6}"/><line class="tick" stroke-width="${big ? 1.4 : 2.6}"/>
    ${big ? '<text class="big-val" x="50" y="53"></text>' : ''}`;
  el.appendChild(svg);
  const val = document.createElement('div');
  val.className = 'val';
  if (!big) el.appendChild(val);
  page.appendChild(el);

  const arc = svg.querySelector('.arc'), tick = svg.querySelector('.tick'), bigVal = svg.querySelector('.big-val');
  onRender(id, () => {
    const n = Math.min(1, Math.max(0, norm(k, getParam(id))));
    const a = START + n * (END - START);
    arc.setAttribute('d', n > 0.001 ? arcPath(50, 50, r, START, a) : '');
    const r1 = r - stroke * 2.5 - (big ? 3 : 2), r0 = r1 - (big ? 9 : 12);
    tick.setAttribute('x1', 50 + r0 * Math.sin(a)); tick.setAttribute('y1', 50 - r0 * Math.cos(a));
    tick.setAttribute('x2', 50 + r1 * Math.sin(a)); tick.setAttribute('y2', 50 - r1 * Math.cos(a));
    const text = k.fmt(getParam(id));
    if (bigVal) { if (bigVal.textContent !== text) bigVal.textContent = text; }
    else if (val.textContent !== text) val.textContent = text;
  });

  let startY = 0, startN = 0;
  svg.addEventListener('pointerdown', (e) => {
    svg.setPointerCapture(e.pointerId);
    startY = e.clientY;
    startN = norm(k, getParam(id));
  });
  svg.addEventListener('pointermove', (e) => {
    if (!svg.hasPointerCapture(e.pointerId)) return;
    const n = Math.min(1, Math.max(0, startN + (startY - e.clientY) / (e.shiftKey ? 800 : 200)));
    const v = denorm(k, n);
    if (v !== getParam(id)) setParam(id, v);
  });
  svg.addEventListener('dblclick', () => {
    const d = id in programDefaults ? programDefaults[id] : engine.settings[id];
    if (d !== undefined) setParam(id, d);
  });
  return el;
}

/** A menu. */
function choice(page, id, label, x, y, width = 80) {
  const el = document.createElement('div');
  el.className = 'ctl';
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.style.width = `${width}px`;
  el.innerHTML = `<div class="cap caps">${label}</div>`;
  const sel = document.createElement('select');
  for (const [v, text] of CHOICES[id]) sel.add(new Option(text, String(v)));
  sel.onchange = () => {
    const opt = CHOICES[id].find(([v]) => String(v) === sel.value);
    setParam(id, opt[0]);
  };
  el.appendChild(sel);
  page.appendChild(el);
  onRender(id, () => { const v = String(getParam(id)); if (sel.value !== v) sel.value = v; });
  return el;
}

/** A pill switch; for a two-way choice, `onValue` is its "on" value. */
function pill(page, id, label, x, y, width = 80, onValue = true, offValue = false) {
  const b = document.createElement('button');
  b.className = 'pill';
  b.textContent = label;
  b.style.position = 'absolute';
  b.style.left = `${x}px`;
  b.style.top = `${y}px`;
  b.style.width = `${width}px`;
  b.onclick = () => setParam(id, getParam(id) === onValue ? offValue : onValue);
  page.appendChild(b);
  onRender(id, () => b.classList.toggle('on', getParam(id) === onValue));
  return b;
}

function section(page, title, x, y, width) {
  const el = document.createElement('div');
  el.className = 'section';
  el.style.left = `${x}px`; el.style.top = `${y}px`; el.style.width = `${width}px`;
  el.innerHTML = `<span class="caps brass" style="font-size:10px">${title}</span><span class="rule"></span>`;
  page.appendChild(el);
}

// PERFORM
{
  const pg = $('perform');
  [['chords', 'Chords'], ['arp', 'Arp'], ['play', 'Auto'], ['latch', 'Latch']].forEach(([id, label], i) =>
    id === 'play' ? pill(pg, 'play', label, 28 + i * 88, 228, 80, 'Auto', 'Keys') : pill(pg, id, label, 28 + i * 88, 228, 80));
  knob(pg, 'cutoff', 'Cutoff', 410, 40, { big: true });
  knob(pg, 'reverb', 'Space', 606, 40, { big: true });
  [['resonance', 'Resonance'], ['sweepDepth', 'Motion'], ['attack', 'Attack'], ['release', 'Release'], ['delay', 'Echo'], ['volume', 'Volume']]
    .forEach(([id, label], i) => knob(pg, id, label, 836 + (i % 2) * 90, 4 + Math.floor(i / 2) * 106));
}

// SOUND
{
  const pg = $('sound');
  const cell = 72, gap = 24;
  const rows = [
    { y: 8, groups: [['OSCILLATORS', ['wave', 'detune', 'sub', 'glide']], ['FILTER', ['cutoff', 'resonance', 'envAmount']], ['SWEEP', ['sweep', 'sweepRate', 'sweepDepth']], ['TIMING', ['bpm']]] },
    { y: 166, groups: [['ENVELOPE', ['attack', 'decay', 'sustain', 'release']], ['ARPEGGIATOR', ['arp', 'latch', 'arpMode', 'arpRate', 'arpOctaves', 'arpGate']], ['EFFECTS', ['delay', 'reverb', 'volume']]] },
  ];
  const labels = { wave: 'Wave', detune: 'Detune', sub: 'Sub', glide: 'Glide', cutoff: 'Cutoff', resonance: 'Resonance', envAmount: 'Env amt',
    sweep: 'Shape', sweepRate: 'Rate', sweepDepth: 'Depth', bpm: 'Tempo', attack: 'Attack', decay: 'Decay', sustain: 'Sustain', release: 'Release',
    arp: 'Arp', latch: 'Latch', arpMode: 'Mode', arpRate: 'Rate', arpOctaves: 'Octaves', arpGate: 'Gate', delay: 'Delay', reverb: 'Reverb', volume: 'Volume' };
  for (const row of rows) {
    let x = 24;
    for (const [title, ids] of row.groups) {
      section(pg, title, x, row.y, ids.length * cell);
      ids.forEach((id, i) => {
        const cx = x + i * cell, cy = row.y + 26;
        if (KNOBS[id]) knob(pg, id, labels[id], cx, cy);
        else if (CHOICES[id]) choice(pg, id, labels[id], cx + 4, cy, cell - 8);
        else pill(pg, id, labels[id], cx + 4, cy + 22, cell - 8);
      });
      x += ids.length * cell + gap;
    }
  }
}

// CHORDS
{
  const pg = $('chords');
  const cell = 88;
  section(pg, 'HARMONY', 24, 8, 9 * cell);
  const ids = [['chords', 'Chords'], ['key', 'Key'], ['scale', 'Scale'], ['type', 'Type'], ['voicing', 'Voicing'],
    ['inversion', 'Inversion'], ['strum', 'Strum'], ['bass', 'Bass'], ['map', 'Key map']];
  ids.forEach(([id, label], i) => {
    const x = 24 + i * cell, y = 34;
    if (KNOBS[id]) knob(pg, id, label, x + 8, y).dataset.chordCtl = id;
    else if (CHOICES[id]) choice(pg, id, label, x + 6, y, cell - 12).dataset.chordCtl = id;
    else pill(pg, id, label, x + 4, y + 22, cell - 8);
  });
  section(pg, 'PROGRESSION', 24, 160, 620);
  choice(pg, 'progression', 'Progression', 24, 186, 240);
  choice(pg, 'play', 'Play', 286, 186, 110);
  choice(pg, 'length', 'Chord length', 418, 186, 110);
}

// Tiles
const tiles = [];
for (let d = 0; d < 8; d++) {
  const t = document.createElement('div');
  t.className = 'tile';
  t.innerHTML = '<div class="n caps"></div><div class="c"></div>';
  let down = -1;
  t.addEventListener('pointerdown', (e) => {
    t.setPointerCapture(e.pointerId);
    ensureAudio();
    if (!engine.settings.chords) setParam('chords', true);
    const pr = engine.progression();
    down = pr ? 60 + [0, 2, 4, 5, 7, 9, 11, 12][d] : C.padNote(engine.settings, Math.min(d, 6));
    engine.inputOn(down, 100, { pad: true });
    renderTiles();
  });
  const up = () => { if (down >= 0) { engine.inputOff(down, { pad: true }); down = -1; renderTiles(); } };
  t.addEventListener('pointerup', up);
  t.addEventListener('pointercancel', up);
  $('tiles').appendChild(t);
  tiles.push(t);
}

// ============================================================================  chord-dependent views

function renderTiles() {
  const s = engine.settings;
  const pr = engine.progression();
  const count = pr ? pr.chords.length : 7;
  const lit = engine.active();
  tiles.forEach((t, d) => {
    const show = d < count;
    t.style.display = show ? '' : 'none';
    if (!show) return;
    const n = pr ? `Chord ${d + 1}` : C.ROMAN[d];
    const c = pr ? C.progressionChordName(pr.chords[d], s.key) : C.chordName(s, d);
    const nEl = t.querySelector('.n'), cEl = t.querySelector('.c');
    if (nEl.textContent !== n) nEl.textContent = n;
    if (cEl.textContent !== c) cEl.textContent = c;
    t.classList.toggle('lit', lit.has(d));
  });
}

function renderInfo() {
  const pr = programs[program];
  const prog = engine.progression();
  $('category').textContent = pr.category;
  $('presetName').textContent = pr.patch.name;
  $('infoCat').textContent = `${pr.category}   ${program + 1} / ${programs.length}`;
  $('infoName').textContent = pr.patch.name;
  if (prog) {
    $('infoRoman').textContent = prog.roman;
    $('infoChords').textContent = prog.chords.map((c) => C.progressionChordName(c, engine.settings.key)).join('  ·  ');
  } else {
    $('infoRoman').textContent = engine.settings.chords ? 'Chords on: every key plays a chord in the key and scale.' : 'Plays single notes. Turn Chords on, or choose a Film program.';
    $('infoChords').textContent = '';
  }
  $('infoDesc').textContent = pr.description;
}

function renderChordState() {
  const progOn = !!engine.progression();
  for (const el of document.querySelectorAll('[data-chord-ctl]')) {
    el.classList.toggle('dim', progOn && ['type', 'inversion', 'map'].includes(el.dataset.chordCtl));
  }
  renderTiles();
  renderInfo();
}

// ============================================================================  programs

function loadProgram(i) {
  program = (i + programs.length) % programs.length;
  stopAllNotes();
  p = { ...NoirPrograms.patch(program), volume: p.volume, bpm: p.bpm, latch: false };
  programDefaults = { ...p };
  engine.settings = NoirPrograms.chordSettings(program, engine.settings);
  synth.apply(p);
  sweepStart = now();
  for (const fns of renderers.values()) for (const fn of fns) fn();
  renderChordState();
  save();
}

$('prev').onclick = () => loadProgram(program - 1);
$('next').onclick = () => loadProgram(program + 1);
$('presetName').onclick = (e) => {
  e.stopPropagation();
  const menu = $('presetMenu');
  if (menu.classList.toggle('open')) {
    menu.innerHTML = '';
    let cat = '';
    programs.forEach((pr, i) => {
      if (pr.category !== cat) {
        cat = pr.category;
        const h = document.createElement('div');
        h.className = 'head caps brass';
        h.textContent = cat;
        menu.appendChild(h);
      }
      const it = document.createElement('div');
      it.className = 'item' + (i === program ? ' on' : '');
      it.textContent = pr.patch.name;
      it.onclick = () => { menu.classList.remove('open'); loadProgram(i); };
      menu.appendChild(it);
    });
  }
};
document.addEventListener('pointerdown', (e) => { if (!$('presetMenu').contains(e.target) && e.target !== $('presetName')) $('presetMenu').classList.remove('open'); });

for (const b of $('tabs').querySelectorAll('button')) {
  b.onclick = () => {
    for (const o of $('tabs').querySelectorAll('button')) o.classList.toggle('on', o === b);
    for (const pg of document.querySelectorAll('.page')) pg.classList.toggle('on', pg.id === b.dataset.page);
  };
}

// ============================================================================  output and timing

const now = () => performance.now() / 1000;

function lunaTempo() {
  return session ? NoirLogic.tempo(session, undefined) : undefined;
}
const currentTempo = () => lunaTempo() ?? p.bpm;

function beatsPerBar() {
  const ts = session?.transport?.timeSignature?.value;
  const n = ts?.numerator ?? ts?.num, d = ts?.denominator ?? ts?.den;
  return n > 0 && d > 0 ? (n * 4) / d : 4;
}

async function ensureAudio() {
  await synth.start();
  synth.setTempo(currentTempo());
  synth.apply(p);
  applyVolume();
}

function applyVolume() {
  if (!synth.ctx) return;
  synth.master.gain.setTargetAtTime(output === 'luna' ? 0 : p.volume, synth.time, 0.03);
}

for (const b of $('output').querySelectorAll('button')) {
  b.onclick = async () => {
    output = b.dataset.v;
    for (const o of $('output').querySelectorAll('button')) o.classList.toggle('on', o === b);
    if (output === 'window') await lunaOut?.allOff();
    await ensureAudio();
    renderLunaInfo();
    save();
  };
}
const toWindow = () => output !== 'luna';
const toLuna = () => output !== 'window' && lunaOut?.ready;

// Light: a note pulses it; each note or chord drops a ripple above its key.
function keyX(note) {
  while (note < 36) note += 12;
  while (note > 96) note -= 12;
  const el = document.querySelector(`.key[data-note="${note}"]`);
  const r = el?.getBoundingClientRect();
  return r ? (r.left + r.width / 2) / window.innerWidth : 0.5;
}
function lightNote(note) {
  light.kick();
  const app = $('app').getBoundingClientRect();
  const y = (app.top + 124 + Math.random() * 360) / window.innerHeight;
  light.drop(keyX(note), y);
}

function soundOn(note, vel, when) {
  if (toWindow()) synth.noteOn(note, vel, when);
  if (toLuna()) lunaAt(when, () => lunaOut.noteOn(note, vel));
  const delay = when ? Math.max(0, (when - synth.time) * 1000) : 0;
  setTimeout(() => { lightNote(note); paintKey(note, true); }, delay);
}
function soundOff(note, when) {
  if (toWindow()) synth.noteOff(note, when);
  if (toLuna()) lunaAt(when, () => lunaOut.noteOff(note));
  const delay = when ? Math.max(0, (when - synth.time) * 1000) : 0;
  setTimeout(() => paintKey(note, false), delay);
}
function lunaAt(when, fn) {
  const ms = when ? Math.max(0, (when - synth.time) * 1000) : 0;
  const run = () => fn().catch((e) => ($('status').textContent = e.message));
  ms < 4 ? run() : setTimeout(run, ms);
}

// ============================================================================  held notes and arpeggiator (from the Noir Synth Add On)

let held = [];
let latchSet = [];
let arpTimer = null;
let arpStep = 0;
let nextStepTime = 0;
const arpNotes = () => (p.latch && !held.length ? latchSet : held);

function press(note, vel = 100) {
  if (held.includes(note)) return;
  if (!held.length && !arpNotes().length) sweepStart = now();
  if (p.latch && !held.length) latchSet = [];
  held.push(note);
  if (p.latch) latchSet.push(note);
  if (p.arp) startArp();
  else soundOn(note, vel);
}

function unpress(note) {
  const i = held.indexOf(note);
  if (i < 0) return;
  held.splice(i, 1);
  if (!p.arp) soundOff(note);
  else if (!arpNotes().length) stopArp();
}

function startArp() {
  if (arpTimer || !synth.ctx) return;
  arpStep = 0;
  nextStepTime = synth.time + 0.03;
  arpTimer = setInterval(arpTick, 25);
  arpTick();
}
function stopArp() {
  clearInterval(arpTimer);
  arpTimer = null;
}
function arpTick() {
  const seq = NoirLogic.arpSequence(arpNotes(), p.arpMode, p.arpOctaves);
  if (!seq.length) return stopArp();
  const step = NoirLogic.stepSeconds(currentTempo(), p.arpRate);
  while (nextStepTime < synth.time + 0.12) {
    const note = NoirLogic.arpNote(seq, p.arpMode, arpStep++);
    const accent = arpStep % 4 === 1 ? 112 : 92;
    soundOn(note, accent, nextStepTime);
    soundOff(note, nextStepTime + step * p.arpGate);
    nextStepTime += step;
  }
}

function stopAllNotes() {
  engine.allOff();
  stopArp();
  for (const n of [...held]) unpress(n);
  held = [];
  latchSet = [];
  synth.allOff();
  lunaOut?.allOff();
  for (const k of document.querySelectorAll('.key.on')) k.classList.remove('on');
  renderTiles();
}
$('panic').onclick = async () => {
  stopAllNotes();
  if (luna) await new Luna.SendMidi(luna).sendAllNotesOff().catch(() => {});
};

// ============================================================================  Auto progression player

let autoPending = false;
let autoNext = 0;

function autoTick() {
  if (!engine.auto.active) return;
  const tempo = currentTempo();
  const chordBeats = C.LENGTHS[engine.settings.length] * beatsPerBar();
  const chordSec = (chordBeats * 60) / tempo;
  const t = now();
  const playing = session?.transport.playing.value === true;
  const toBar = () => NoirLogic.secondsToBoundary(session?.transport.location.value?.bar_beat, playing, tempo, chordBeats, beatsPerBar(), Luna.TICKS_PER_BEAT);
  if (autoPending) {
    autoPending = false;
    engine.fireAuto();
    const b = toBar();
    autoNext = t + (b !== undefined && b > 0.15 ? b : chordSec);   // first change on LUNA's next boundary
  } else if (t >= autoNext) {
    engine.fireAuto();
    const b = toBar();
    autoNext = b !== undefined && b > 0.15 && b < chordSec - 0.15 ? t + b : autoNext + chordSec; // stay on LUNA's bars
    if (autoNext <= t) autoNext = t + chordSec;
  } else return;
  renderTiles();
}
setInterval(autoTick, 15);

// ============================================================================  inputs

function keyDown(note, vel = 100) {
  ensureAudio();
  if (engine.inputOn(note, vel) === 'auto-start') { autoPending = true; autoTick(); }
  renderTiles();
}
function keyUp(note) {
  engine.inputOff(note);
  renderTiles();
}

// Keyboard: C1..C6 (LUNA names middle C "C3").
const LOW = 36, HIGH = 96;
let qwertyBase = 60;
const QWERTY = 'awsedftgyhujkolp;'.split('');
const isBlack = (n) => [1, 3, 6, 8, 10].includes(n % 12);
function buildKeys() {
  const root = $('keys');
  root.innerHTML = '';
  const whites = [];
  for (let n = LOW; n <= HIGH; n++) if (!isBlack(n)) whites.push(n);
  const w = root.clientWidth / whites.length;
  for (let n = LOW; n <= HIGH; n++) {
    const el = document.createElement('div');
    el.className = 'key' + (isBlack(n) ? ' black' : '') + (n >= qwertyBase && n < qwertyBase + QWERTY.length ? ' qw' : '');
    el.dataset.note = n;
    if (isBlack(n)) {
      const left = whites.indexOf(n - 1) + 1;
      el.style.left = `${left * w - w * 0.3}px`;
      el.style.width = `${w * 0.6}px`;
    } else {
      el.style.left = `${whites.indexOf(n) * w}px`;
      el.style.width = `${w}px`;
      if (n % 12 === 0) el.innerHTML = `<span>C${n / 12 - 2}</span>`;
    }
    el.addEventListener('pointerdown', (e) => { el.setPointerCapture(e.pointerId); keyDown(n, 100); });
    el.addEventListener('pointerup', () => keyUp(n));
    el.addEventListener('pointercancel', () => keyUp(n));
    root.appendChild(el);
  }
}
function paintKey(note, on) {
  document.querySelector(`.key[data-note="${note}"]`)?.classList.toggle('on', on);
}

// Computer keys (A W S E D ... play from C3; Z / X shift the octave). Ours first, the rest go to LUNA.
const typingIn = (e) => /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName);
const qwHeld = new Map();
window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || typingIn(e)) return;
  const k = e.key.toLowerCase();
  const i = QWERTY.indexOf(k);
  if (i >= 0) {
    e.preventDefault();
    if (!e.repeat && !qwHeld.has(k)) { qwHeld.set(k, qwertyBase + i); keyDown(qwertyBase + i, 100); }
  } else if (k === 'z' || k === 'x') {
    e.preventDefault();
    if (!e.repeat) { qwertyBase = Math.min(84, Math.max(36, qwertyBase + (k === 'z' ? -12 : 12))); buildKeys(); }
  }
}, true);
window.addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  if (qwHeld.has(k)) { e.preventDefault(); keyUp(qwHeld.get(k)); qwHeld.delete(k); }
}, true);
window.addEventListener('blur', () => { for (const [k, n] of qwHeld) { keyUp(n); qwHeld.delete(k); } });

// ============================================================================  sweep and light level

let sweepStart = now();
let lastLunaSweep = 0;
let lunaSweeping = false;
const levelBuf = new Float32Array(512);
setInterval(() => {
  const pos = NoirLogic.filterPosition(p.cutoff, p.sweep, now() - sweepStart, p.sweepRate, p.sweepDepth);
  synth.setFilterPosition(pos);

  const playing = held.length > 0 || arpTimer !== null || engine.auto.active;
  if (toLuna() && playing) {
    if (now() - lastLunaSweep >= 0.05) {
      lastLunaSweep = now();
      lunaSweeping = true;
      lunaOut.sweep(pos).catch(() => {});
    }
  } else if (lunaSweeping) {
    lunaSweeping = false;
    lunaOut?.endSweep();
  }

  // The light glows with what the window synth plays.
  if (synth.analyser && toWindow()) {
    synth.analyser.getFloatTimeDomainData(levelBuf);
    let peak = 0;
    for (const v of levelBuf) peak = Math.max(peak, Math.abs(v));
    light.level = Math.min(1, peak * 1.6);
  } else light.level = 0;
}, 33);

$('lightToggle').onclick = () => { light.setEnabled(!light.enabled); $('lightToggle').classList.toggle('on', light.enabled); save(); };

// ============================================================================  LUNA

function renderLunaInfo() {
  const info = $('lunaInfo');
  let text;
  if (output === 'window') text = 'Playing in this window.';
  else {
    const track = session?.focusedTrack.value;
    if (!track) text = 'Select an instrument track in LUNA.';
    else {
      const param = lunaOut?.paramName;
      text = `→ ${track.name.value ?? track.id}${param ? ` · sweep drives "${param}"` : ''} · arm or monitor the track to hear it`;
    }
  }
  if (info.textContent !== text) info.textContent = text;
}

async function bindTrack() {
  releaseAll(trackReleases);
  const track = session?.focusedTrack.value;
  if (track) await track.loadStrip();
  await lunaOut.setTarget(session, track);
  renderLunaInfo();
}

async function bindSession() {
  releaseAll(sessionReleases);
  releaseAll(trackReleases);
  session = luna.sessions.current();
  if (!session) {
    $('status').textContent = 'no session open';
    await lunaOut.setTarget(undefined, undefined);
    renderLunaInfo();
    return;
  }
  await session.ready();
  const paintName = () => ($('status').textContent = session.name.value ?? session.uid);
  paintName();
  sessionReleases.push(session.name.onChange(paintName));
  sessionReleases.push(session.focusedTrack.onChange(bindTrack));
  const tempoChanged = () => { synth.setTempo(currentTempo()); for (const fn of renderers.get('bpm') ?? []) fn(); };
  if (session.transport.tempo?.onChange) sessionReleases.push(session.transport.tempo.onChange(tempoChanged));
  tempoChanged();
  await bindTrack();
}

async function listenToMidiKeyboards() {
  try {
    await luna.midiDevices.load();
    new Luna.MidiInput(luna).onNote('all', (note, velocity, on) => (on && velocity > 0 ? keyDown(note, velocity) : keyUp(note)));
  } catch (e) {
    console.warn('MIDI input unavailable', e);
  }
}

async function connect() {
  for (;;) {
    try {
      luna = await Luna.connect();
      break;
    } catch (e) {
      $('status').textContent = e instanceof Luna.NotRunning ? 'waiting for LUNA... (plays here meanwhile)' : e.message;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  lunaOut = new LunaOut(luna);
  Luna.bindShortcuts(luna);
  await luna.sessions.ready();
  luna.sessions.focused.onChange(bindSession);
  luna.sessions.items.onChange(bindSession);
  luna.status.onChange(() => {
    if (luna.status.value === 'disconnected') $('status').textContent = 'reconnecting...';
  });
  await bindSession();
  listenToMidiKeyboards();
}

// ============================================================================  saved state (this window only)

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORE, JSON.stringify({ program, p, chords: engine.settings, output, light: light.enabled }));
    } catch (e) { /* storage unavailable: fine */ }
  }, 300);
}
function restore() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE) ?? 'null');
    if (!s) return;
    program = Math.min(programs.length - 1, Math.max(0, s.program ?? 0));
    p = { ...NoirPrograms.patch(program), ...s.p, latch: false };
    programDefaults = { ...NoirPrograms.patch(program), volume: p.volume, bpm: p.bpm, latch: false };
    engine.settings = { ...C.DEFAULT_CHORDS, ...s.chords };
    if (s.output) { output = s.output; for (const o of $('output').querySelectorAll('button')) o.classList.toggle('on', o.dataset.v === output); }
    if (s.light === false) light.setEnabled(false);
  } catch (e) { /* ignore a bad saved state */ }
}

// ============================================================================  start

window.addEventListener('pointerdown', ensureAudio, { once: true });
window.addEventListener('keydown', ensureAudio, { once: true });

restore();
synth.apply(p);
for (const fns of renderers.values()) for (const fn of fns) fn();
$('lightToggle').classList.toggle('on', light.enabled);
buildKeys();
renderChordState();
renderLunaInfo();
connect();
