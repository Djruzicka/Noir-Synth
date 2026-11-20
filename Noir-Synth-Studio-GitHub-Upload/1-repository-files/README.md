# Noir Synth Studio

The Noir Synth instrument as a **LUNA Add On**: the same sound, the 25 programs (5 Signature + 20 Film
progressions), chords with voice leading, Auto play, the Perform / Sound / Chords pages, and the light on
water with ripples, in one window. It's a web port of the plug-in in `~/luna-add-ons/noir-synth-plugin`;
the original Noir Synth Add On (`~/luna-add-ons/noir-synth`) is unchanged.

| | |
|---|---|
| Opens | LUNA > Add Ons > Windows > **Noir Synth Studio** (shown while a session is open) |
| Maker / id | Noir Lab, `com.noirlab.noir_synth_studio` |
| Showcase category | Create |
| SDK | `@uaudio/luna-builder-sdk` 3.1.2 |

## Playing it

- **Keys**: the on-screen keyboard (C1 to C6, LUNA naming), the computer keys A W S E D F T G Y H U J K O L P ;
  (from C3; Z / X shift the octave), or any MIDI keyboard LUNA sees.
- **Programs**: the arrows beside the name, or click the name for the list (Signature / Film).
- **Chords**: with Chords on, each key plays a chord in the Key and Scale (Chords page). Film programs turn it on
  with their progression.
- **Auto** (Film programs): hold one key and the progression plays rooted on it, one chord per Chord Length,
  at LUNA's tempo; while LUNA plays, the changes land on LUNA's bars. Hold another key to transpose.
  **Keys**: C D E F G A B pick chord 1, 2, 3... of the progression instead.
- **Tiles**: always play one chord each, and light up with the chord that's sounding.
- **Light**: the sunlight on water drifts behind the controls, pulses with each note and drops a ripple above
  the key you played. The **Light** switch turns it off.

## Where the sound goes

- **Window** (default): the Web Audio synth in this window. It does not go through LUNA's mixer, so it can't be
  recorded as audio.
- **LUNA track**: notes go as MIDI to the selected instrument track (arm or monitor it to hear it, record to
  capture the MIDI). The sweep goes as CC 74 and to the instrument's **Cutoff** parameter when it has one.
  With the **Noir Synth plug-in** on that track, turn the plug-in's own Chords and Arp off: Studio already sends
  finished chords and arpeggios.
- **Both**: the two at once.

## Develop

```bash
cd ~/luna-add-ons/noir-synth-studio && npm test
```

```bash
cd ~/luna-add-ons/noir-synth-studio && npx ua-builder serve
```

`npm test` runs 19 tests against `Luna.MockEngine` (chords, voicings and progressions checked against the
plug-in's output, programs, strum, Auto, timing, LUNA output). `serve` opens it at http://localhost:8790/ against a
running LUNA. It's installed into LUNA as a link to this folder (`npx ua-builder install`), so edits show up
the next time the window opens.

| File | What it holds |
|---|---|
| `logic.js` | presets, arp, sweep, chords, the 20 progressions and voice leading, the 25 programs, `ChordEngine`, `LunaOut` (no DOM; tested) |
| `synth.js` | the Web Audio synth (unchanged from the Noir Synth Add On) |
| `light.js` | the caustic light and ripples (a small canvas the browser scales up; 12 fps at rest, 24 while moving) |
| `main.js` | the pages, controls, keyboard, tiles, Auto player, arp, routing and LUNA connection |
| `index.html` | layout and styles |
| `tests/studio.test.js` | the tests |

## Sharing it

An Add On is web files, so none of the plug-in's sharing hurdles apply (no code signing, no notarization, no
JUCE licence). Version 1.0.0 ships with its icon (`icon.png`, 256 px).

```bash
cd ~/luna-add-ons/noir-synth-studio && npx ua-builder pack
```

That writes `noir-synth-studio.lunaaddon`; double-clicking it installs it in LUNA. Ways LUNA's Add On showcase
can install it (from the LUNA Builder SDK's notes):

- **A public GitHub repo**: attach the `.lunaaddon` to a release; LUNA installs every `.lunaaddon` in the repo's
  latest release, and re-reads it at each launch, so a new release is an update.
- **A share link** to the file on Google Drive ("Anyone with the link"), iCloud Drive (public share) or Dropbox.
- **The showcase list itself** is curated by UA (a list of repos): getting listed there is UA's call, so ask the
  UA Universe / LUNA team.

Before posting it anywhere public, check how UA wants employee-made Add Ons published and credited.
