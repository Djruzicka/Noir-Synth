// Runs against Luna.MockEngine: no LUNA needed. `npm test`.
// Expected chords are the ones the Noir Synth plug-in's C++ engine produces (same voicings).
import { describe, expect, it } from 'vitest';
import { Luna } from '@uaudio/luna-builder-sdk';

globalThis.Luna = Luna; // logic.js is a classic script that reads the Luna global
await import('../logic.js');
const { NoirLogic: logic, NoirChords: C, NoirPrograms: Programs, ChordEngine, LunaOut } = globalThis;

async function connected() {
  const engine = new Luna.MockEngine();
  engine.addSession('abc', { name: 'Demo', tracks: ['Synth', 'Bass'] });
  await engine.settled();
  const luna = await Luna.connect({ port_: engine.port() });
  const session = await luna.session();
  return { engine, luna, session };
}

const aMinor = { ...C.DEFAULT_CHORDS, chords: true };

describe('diatonic chords (same as the plug-in)', () => {
  it('names the chords of A minor and C major', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((d) => C.chordName(aMinor, d))).toEqual(['Am7', 'Bm7b5', 'Cmaj7', 'Dm7', 'Em7', 'Fmaj7', 'G7']);
    const cMaj9 = { ...aMinor, key: 0, scale: 'Major', type: '9th' };
    expect([0, 1, 2, 3, 4, 5, 6].map((d) => C.chordName(cMaj9, d))).toEqual(['Cmaj9', 'Dm9', 'Em7(b9)', 'Fmaj9', 'G9', 'Am9', 'Bm7b5(b9)']);
    expect([0, 1, 6].map((d) => C.chordName({ ...aMinor, type: 'Triad' }, d))).toEqual(['Am', 'Bdim', 'G']);
  });

  it('builds, snaps, inverts and voices chords', () => {
    expect(C.chordFor(aMinor, 57)).toEqual([57, 60, 64, 67]);           // A3 -> Am7
    expect(C.chordFor(aMinor, 58)).toEqual([57, 60, 64, 67]);           // A#3 snaps down to A
    expect(C.chordFor(aMinor, 60)).toEqual([60, 64, 67, 71]);           // C4 -> Cmaj7
    expect(C.chordFor({ ...aMinor, inversion: 1 }, 57)).toEqual([60, 64, 67, 69]);
    expect(C.chordFor({ ...aMinor, voicing: 'Open' }, 57)).toEqual([52, 57, 60, 67]);
    expect(C.chordFor({ ...aMinor, voicing: 'Wide' }, 57)).toEqual([52, 57, 60, 79]);
    expect(C.chordFor({ ...aMinor, bass: true }, 57)).toEqual([45, 57, 60, 64, 67]);
  });

  it('maps white keys to degrees I to VII in any key', () => {
    const w = { ...aMinor, map: 'White keys' };
    expect(C.chordFor(w, 60)).toEqual([57, 60, 64, 67]);                // C4 -> I (Am7)
    expect(C.chordFor(w, 67)).toEqual([64, 67, 71, 74]);                // G4 -> V (Em7)
    expect([0, 1, 2, 3, 4, 5, 6].map((d) => C.padNote(aMinor, d))).toEqual([57, 59, 60, 62, 64, 65, 67]);
  });
});

describe('progressions and voice leading (same as the plug-in)', () => {
  const lead = (name, key, voicing, bass) => {
    const pr = C.PROGRESSIONS.find((p) => p.name === name);
    let root = 48 + key;
    if (key >= 6) root -= 12;
    return pr.chords.map((c) => C.voiceLed(c, root + c.offset, root + 7, voicing, bass, pr.rootPosition));
  };

  it('has 20 progressions with names and roman numerals', () => {
    expect(C.PROGRESSIONS).toHaveLength(20);
    for (const p of C.PROGRESSIONS) expect(p.name && p.roman && p.chords.length >= 2).toBeTruthy();
  });

  it('voice-leads each chord near one centre', () => {
    expect(lead('Hold The Line', 9, 'Open', true)[0]).toEqual([33, 48, 57, 64]);
    expect(lead('Dream Within', 9, 'Close', true)[0]).toEqual([33, 48, 52, 57]);
    expect(lead('Fog Drone', 0, 'Wide', true)[0]).toEqual([36, 50, 60, 79]);
  });

  it('keeps the Descent Line moving voice on top', () => {
    const tops = lead('Descent Line', 9, 'Close', true).map((c) => c[c.length - 1] % 12);
    expect(tops).toEqual([9, 8, 7, 6]); // A, G#, G, F#
  });

  it('names progression chords in the key', () => {
    const pr = C.PROGRESSIONS[1];
    expect(pr.chords.map((c) => C.progressionChordName(c, 9))).toEqual(['Am', 'Em', 'G', 'D']);
  });
});

describe('factory programs', () => {
  it('has 5 Signature and 20 Film programs, each complete', () => {
    const progs = Programs.PROGRAMS;
    expect(progs).toHaveLength(25);
    expect(progs.filter((p) => p.category === 'Signature')).toHaveLength(5);
    const keys = Object.keys(Programs.patch(0)).sort();
    progs.forEach((p, i) => {
      expect(Object.keys(Programs.patch(i)).sort()).toEqual(keys);
      if (p.chords) expect(C.PROGRESSIONS[p.chords.progression]).toBeDefined();
    });
  });

  it('Film programs bring their progression; Signature ones play plain notes', () => {
    const film = Programs.chordSettings(6, aMinor); // Dream Within
    expect(film).toMatchObject({ chords: true, progression: 1, play: 'Auto', length: '2 bars' });
    expect(Programs.chordSettings(0, film)).toMatchObject({ chords: false, progression: -1 });
  });
});

describe('chord engine', () => {
  function rig(settings) {
    const log = [];
    const timers = [];
    const out = { on: (n) => log.push(`+${n}`), off: (n) => log.push(`-${n}`) };
    const schedule = (fn) => { const t = { fn, cancelled: false }; timers.push(t); return () => (t.cancelled = true); };
    const e = new ChordEngine(out, schedule);
    Object.assign(e.settings, settings);
    const flush = () => { for (const t of timers.splice(0)) if (!t.cancelled) t.fn(); };
    return { e, log, flush };
  }

  it('passes single notes through when Chords is off', () => {
    const { e, log } = rig({ chords: false });
    e.inputOn(60); e.inputOff(60);
    expect(log).toEqual(['+60', '-60']);
  });

  it('turns a key into a chord and shares notes between chords', () => {
    const { e, log } = rig({ chords: true });
    e.inputOn(57);                       // Am7: 57 60 64 67
    e.inputOn(60);                       // Cmaj7: 60 64 67 71 (60 64 67 already sounding)
    expect(log).toEqual(['+57', '+60', '+64', '+67', '+71']);
    expect([...e.active()].sort()).toEqual([0, 2]);
    e.inputOff(57);                      // only A goes: C, E, G still belong to Cmaj7
    expect(log.slice(5)).toEqual(['-57']);
    e.inputOff(60);
    expect(log.slice(6).sort()).toEqual(['-60', '-64', '-67', '-71']);
  });

  it('strums, and a release cancels notes not yet played', () => {
    const { e, log, flush } = rig({ chords: true, strum: 50 });
    e.inputOn(57);
    expect(log).toEqual(['+57']);
    e.inputOff(57);
    flush();
    expect(log).toEqual(['+57', '-57']);
  });

  it('Auto: one held key plays the progression, transposes, and stops on release', () => {
    const { e, log } = rig({ chords: true, progression: 1, play: 'Auto', bass: false }); // Dream Within
    expect(e.inputOn(57)).toBe('auto-start');
    expect(log).toEqual([]);                          // the player fires on its own clock
    const steps = [e.fireAuto(), e.fireAuto(), e.fireAuto(), e.fireAuto(), e.fireAuto()].map((x) => x.step);
    expect(steps).toEqual([0, 1, 2, 3, 0]);
    expect([...e.active()]).toEqual([0]);
    expect(e.inputOn(59)).toBe('auto');               // second key: next chords rooted on B
    expect(e.auto.root).toBe(59);
    e.inputOff(59);
    expect(e.auto.root).toBe(57);
    e.inputOff(57);
    expect(e.auto.active).toBe(false);
    expect(e.refs.size).toBe(0);                       // every note released
  });

  it('Keys mode: white keys pick progression chords; tiles always play one chord', () => {
    const { e, log } = rig({ chords: true, progression: 1, play: 'Keys', key: 9 });
    e.inputOn(62);                                     // D -> chord 2 (Em)
    expect([...e.active()]).toEqual([1]);
    e.allOff();
    const auto = rig({ chords: true, progression: 1, play: 'Auto' });
    expect(auto.e.inputOn(64, 100, { pad: true })).toBe('chord'); // tile 3 in Auto mode
    expect([...auto.e.active()]).toEqual([2]);
    expect(log.length).toBeGreaterThan(0);
  });
});

describe('timing', () => {
  it('times arp steps and finds the next bar boundary from the playhead', () => {
    expect(logic.stepSeconds(120, '1/16')).toBeCloseTo(0.125);
    expect(logic.secondsToBoundary({ bar: 3, beat: 1, tick: 0 }, true, 120, 4)).toBe(0);
    expect(logic.secondsToBoundary({ bar: 3, beat: 3, tick: 0 }, true, 120, 4)).toBeCloseTo(1);    // 2 beats at 120
    expect(logic.secondsToBoundary({ bar: 2, beat: 2, tick: 0 }, true, 60, 8)).toBeCloseTo(3);     // 2-bar chords: beat 5 of 8
    expect(logic.secondsToBoundary({ bar: 1, beat: 1 }, false, 120, 4)).toBeUndefined();
  });

  it('uses LUNA tempo when known', () => {
    expect(logic.tempo({ transport: { tempo: { value: 96 } } }, 120)).toBe(96);
    expect(logic.tempo(undefined, 120)).toBe(120);
  });
});

describe('LUNA output', () => {
  it('plays notes into the selected track and releases them', async () => {
    const { engine, luna, session } = await connected();
    const out = new LunaOut(luna);
    await out.setTarget(session, session.tracks.byId('Synth'));
    await out.noteOn(60, 100);
    await out.noteOn(67, 90);
    await out.allOff();
    await engine.settled();
    expect(engine.midiSent.filter((m) => m.trackUid === 'Synth')).toHaveLength(4);
    expect(out.sounding.size).toBe(0);
  });

  it('sends the sweep as CC 74 and skips repeats', async () => {
    const { engine, luna, session } = await connected();
    const out = new LunaOut(luna);
    await out.setTarget(session, session.tracks.byId('Bass'));
    const before = engine.midiSent.length;
    await out.sweep(0.5); await out.sweep(0.5); await out.sweep(1);
    await engine.settled();
    expect(engine.midiSent.slice(before)).toHaveLength(2);
  });

  it('finds a cutoff-like instrument parameter by name', () => {
    const param = (name) => ({ name: { value: name } });
    expect(logic.cutoffParam({ params: ['Wave', 'Cutoff'].map(param) }).name.value).toBe('Cutoff');
    expect(logic.cutoffParam({ params: ['Volume'].map(param) })).toBeUndefined();
  });
});
