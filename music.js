/* Kodelyra Scan & Play — music engine.
 * Shared by the book builder (Node, for validation) and the website (browser).
 * Turns a compact entry spec (chords, key, groove, melody tokens) into playable tracks:
 *   track = { name, desc, bpm, bpb, len, events: [{ b, d, i, n, v }], marks: [{ b, label, sub }] }
 * b/d are in beats. i = instrument: p piano RH · l piano LH · k kick · c clap · e bell · v clave
 *                                   g güiro · s shaker · m click (accent) · n click
 * dr:1 marks a drum-loop event (the player's Beat switch mutes these).
 * track.lyrics = [{ b0, b1, label, text, en, chords: [{ b, chord }], words: [{ t, b, join }] | null }]
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KMusic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
  const LETTER_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const SHARPS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const FLATS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  const FLAT_KEYS = ['F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Dm', 'Gm', 'Cm', 'Fm', 'Bbm', 'Ebm'];
  /* [semitones, letter steps] — identical to scripts/lib/keyboard-svg.js so sound = diagram */
  const QUALITY = {
    '': [[0, 0], [4, 2], [7, 4]],
    m: [[0, 0], [3, 2], [7, 4]],
    7: [[0, 0], [4, 2], [7, 4], [10, 6]],
    maj7: [[0, 0], [4, 2], [7, 4], [11, 6]],
    m7: [[0, 0], [3, 2], [7, 4], [10, 6]],
    sus2: [[0, 0], [2, 1], [7, 4]],
    sus4: [[0, 0], [5, 3], [7, 4]],
    add9: [[0, 0], [4, 2], [7, 4], [14, 8]],
    dim: [[0, 0], [3, 2], [6, 4]],
    6: [[0, 0], [4, 2], [7, 4], [9, 5]],
    m7b5: [[0, 0], [3, 2], [6, 4], [10, 6]],
    dim7: [[0, 0], [3, 2], [6, 4], [9, 5]],
  };
  const CHORD_RE = /^([A-G](?:#|b)?)(maj7|m7b5|m7|m|7|sus2|sus4|add9|dim7|dim|6)?$/;
  const DEG = ['1', '♭2', '2', '♭3', '3', '4', '♭5', '5', '♭6', '6', '♭7', '7'];

  /* ───────────── pitch helpers ───────────── */

  const pcOf = (name) => (LETTER_PC[name[0]] + (name[1] === '#' ? 1 : name[1] === 'b' ? -1 : 0) + 12) % 12;

  function noteToMidi(note) {
    const m = /^([A-G])(#|b)?(-?\d)$/.exec(note);
    if (!m) throw new Error(`Bad note: ${note}`);
    return (Number(m[3]) + 1) * 12 + LETTER_PC[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  }

  function spell(pc, letter) {
    let d = (pc - LETTER_PC[letter] + 12) % 12;
    if (d > 6) d -= 12;
    return letter + ({ 1: '#', '-1': 'b', 2: '##', '-2': 'bb' }[d] || '');
  }

  const pretty = (s) => String(s)
    .replace(/m7b5/g, 'm7♭5')
    .replace(/([A-G])##/g, '$1𝄪').replace(/([A-G])#/g, '$1♯').replace(/([A-G])bb/g, '$1𝄫').replace(/([A-G])b/g, '$1♭');

  function parseChord(sym) {
    const [main, bass] = String(sym).split('/');
    const m = CHORD_RE.exec(main);
    if (!m) throw new Error(`Unknown chord: ${sym}`);
    if (bass && !/^[A-G](#|b)?$/.test(bass)) throw new Error(`Bad bass note: ${sym}`);
    return { root: m[1], quality: m[2] || '', bass: bass || null };
  }

  /** Chord tones spelled the same way as the book's keyboard diagrams. */
  function chordInfo(sym) {
    const { root, quality, bass } = parseChord(sym);
    const rootPc = pcOf(root);
    const li = LETTERS.indexOf(root[0]);
    const tones = QUALITY[quality].map(([semi, steps]) => ({ semi, name: spell((rootPc + semi) % 12, LETTERS[(li + steps) % 7]) }));
    let rootMidi = 60 + rootPc;
    if (rootMidi >= 69) rootMidi -= 12;
    const rh = tones.map((t) => rootMidi + t.semi);
    const bassPc = bass ? pcOf(bass) : rootPc;
    let lh = 36 + bassPc;
    if (lh < 40) lh += 12;
    return { sym, root, quality, bass, rootPc, bassPc, rh, lh, names: tones.map((t) => t.name), fifth: lh + 7, sixth: lh + 9 };
  }

  /** A bar written "F,G" splits evenly between its chords. */
  function numbersFor(key, chords) {
    const tonic = pcOf(key.replace(/m$/, ''));
    return chords.map((bar) => bar.split(',').map((c) => DEG[(pcOf(parseChord(c).root) - tonic + 12) % 12]).join(','));
  }

  /* ───────────── transpose ───────────── */

  function keyName(key, semis) {
    const minor = /m$/.test(key);
    const pc = (pcOf(key.replace(/m$/, '')) + semis + 120) % 12;
    const flatCandidate = FLATS[pc] + (minor ? 'm' : '');
    const sharpCandidate = SHARPS[pc] + (minor ? 'm' : '');
    if (FLAT_KEYS.includes(flatCandidate)) return flatCandidate;
    if (sharpCandidate.includes('#') && ['F#', 'C#m', 'F#m', 'G#m', 'D#m', 'C#'].indexOf(sharpCandidate) < 0) return flatCandidate;
    return sharpCandidate;
  }

  function transposeChord(sym, semis, useFlats) {
    if (!semis) return sym;
    if (sym.includes(',')) return sym.split(',').map((c) => transposeChord(c, semis, useFlats)).join(',');
    const { root, quality, bass } = parseChord(sym);
    const names = useFlats ? FLATS : SHARPS;
    const r = names[(pcOf(root) + semis + 120) % 12] + quality;
    return bass ? `${r}/${names[(pcOf(bass) + semis + 120) % 12]}` : r;
  }

  function transposeNote(note, semis) {
    const m = noteToMidi(note) + semis;
    return SHARPS[m % 12] + (Math.floor(m / 12) - 1);
  }

  /* ───────────── voice leading ───────────── */

  function inversions(base) {
    const out = [];
    for (let k = 0; k < base.length; k++) {
      let v = base.slice(k).concat(base.slice(0, k).map((m) => m + 12));
      while (v[0] > 64) v = v.map((m) => m - 12);
      while (v[0] < 53) v = v.map((m) => m + 12);
      out.push(v);
    }
    return out;
  }

  function voiceLead(prev, info) {
    if (!prev) return info.rh.slice();
    let best = null;
    let bestCost = Infinity;
    inversions(info.rh).forEach((v) => {
      const cost = v.reduce((s, m) => s + Math.min(...prev.map((p) => Math.abs(p - m))), 0) + (v[v.length - 1] > 79 ? 6 : 0);
      if (cost < bestCost) { bestCost = cost; best = v; }
    });
    return best;
  }

  /* ───────────── grooves ─────────────
   * steps = boxes per bar, bpb = beats per bar. Row instruments:
   * rh (chord until next hit) · rhs (short stab) · rhl (held) · rh1 (short root note) · lhs (short LH chord)
   * arp (broken 1-3-5-3) · up (1-3-5-8)
   * alb (Alberti LH 1-5-3-5) · bass · b5 (fifth) · boog (boogie 5th/6th) · walk (walking bass)
   * kick · clap · bell · clave · guiro · shaker · click
   */
  const GROOVES = {
    ballad: { name: 'Ballad', bpm: 72, rows: [{ i: 'rhl', hits: [0] }, { i: 'bass', hits: [0, 8] }] },
    strings: { name: 'Soft strings', bpm: 66, rows: [{ i: 'pad', hits: [0] }] },
    pop: { name: 'Pop (pushed)', bpm: 100, rows: [{ i: 'rh', hits: [0, 3, 6, 10, 12] }, { i: 'bass', hits: [0, 8] }, { i: 'kick', hits: [0, 8] }, { i: 'clap', hits: [4, 12] }] },
    drive: { name: 'Driving 8ths', bpm: 116, rows: [{ i: 'rhs', hits: [0, 2, 4, 6, 8, 10, 12, 14] }, { i: 'bass', hits: [0, 4, 8, 12] }, { i: 'kick', hits: [0, 8] }, { i: 'clap', hits: [4, 12] }] },
    folk: { name: 'Steady beat', bpm: 96, rows: [{ i: 'rh', hits: [0, 8] }, { i: 'bass', hits: [0, 4, 8, 12] }] },
    twobeat: { name: 'Two-beat bounce', bpm: 104, rows: [{ i: 'bass', hits: [0, 8] }, { i: 'rhs', hits: [4, 12] }] },
    march: { name: 'March', bpm: 104, rows: [{ i: 'bass', hits: [0, 8] }, { i: 'b5', hits: [4, 12] }, { i: 'rh', hits: [0, 8] }] },
    lullaby: { name: 'Gentle rocking', bpm: 66, rows: [{ i: 'bass', hits: [0] }, { i: 'rhl', hits: [8] }] },
    soul: { name: 'Soul groove', bpm: 116, rows: [{ i: 'bass', hits: [0] }, { i: 'b5', hits: [8] }, { i: 'rhs', hits: [4, 12] }, { i: 'clap', hits: [4, 12] }] },
    gospel: { name: 'Soul clap', bpm: 76, rows: [{ i: 'bass', hits: [0, 8] }, { i: 'rh', hits: [0, 4, 8, 12] }, { i: 'clap', hits: [4, 12] }] },
    reggae: { name: 'Reggae one drop', bpm: 76, rows: [{ i: 'rhs', hits: [4, 12] }, { i: 'kick', hits: [8] }, { i: 'bass', hits: [0, 6, 10] }] },
    ska: { name: 'Ska / rocksteady off-beat', bpm: 112, rows: [{ i: 'rhs', hits: [2, 6, 10, 14] }, { i: 'bass', hits: [0, 8] }, { i: 'kick', hits: [0, 8] }] },
    afrobeats: { name: 'Afrobeats 3-3-2', bpm: 104, rows: [{ i: 'bass', hits: [0, 3, 6, 8, 11, 14] }, { i: 'clap', hits: [4, 12] }, { i: 'rhs', hits: [2, 7, 10, 15] }, { i: 'shaker', hits: [0, 2, 4, 6, 8, 10, 12, 14] }] },
    amapiano: { name: 'Amapiano-style', bpm: 112, rows: [{ i: 'kick', hits: [0, 4, 8, 12] }, { i: 'bass', hits: [0, 3, 6, 10, 13] }, { i: 'rhs', hits: [2, 6, 10, 14] }, { i: 'shaker', hits: [2, 6, 10, 14] }] },
    highlife: { name: 'Highlife bell', steps: 12, bpm: 108, rows: [{ i: 'bell', hits: [0, 2, 4, 5, 7, 9, 11] }, { i: 'bass', hits: [0, 3, 6, 9] }, { i: 'arp', hits: [0, 2, 3, 5, 6, 8, 9, 11] }] },
    palmwine: { name: 'Palm-wine picking', bpm: 100, rows: [{ i: 'bass', hits: [0, 4, 8, 12] }, { i: 'arp', hits: [0, 2, 4, 6, 8, 10, 12, 14] }] },
    marabi: { name: 'Marabi / township jive', bpm: 112, rows: [{ i: 'bass', hits: [0, 4, 8, 12] }, { i: 'rhs', hits: [2, 6, 10, 14] }] },
    rumba: { name: 'Rumba clave', bpm: 100, rows: [{ i: 'clave', hits: [0, 3, 7, 10, 12] }, { i: 'bass', hits: [0, 8] }, { i: 'b5', hits: [6] }, { i: 'arp', hits: [0, 2, 4, 6, 8, 10, 12, 14] }] },
    soukous: { name: 'Soukous / benga drive', bpm: 132, rows: [{ i: 'arp', hits: [0, 2, 4, 6, 8, 10, 12, 14] }, { i: 'bass', hits: [0, 4, 8, 12] }, { i: 'shaker', hits: [0, 2, 4, 6, 8, 10, 12, 14] }] },
    son: { name: 'Son clave + tumbao', bpm: 100, rows: [{ i: 'clave', hits: [0, 3, 6, 10, 12] }, { i: 'bass', hits: [6, 12] }, { i: 'rhs', hits: [0, 3, 6, 8, 11, 14] }] },
    cumbia: { name: 'Cumbia', bpm: 96, rows: [{ i: 'bass', hits: [0, 8] }, { i: 'rhs', hits: [4, 12] }, { i: 'guiro', hits: [0, 3, 4, 8, 11, 12] }] },
    samba: { name: 'Samba', bpm: 100, rows: [{ i: 'bass', hits: [0, 4, 8, 12] }, { i: 'rhs', hits: [3, 6, 10, 15] }, { i: 'shaker', hits: [0, 2, 4, 6, 8, 10, 12, 14] }] },
    bossa: { name: 'Bossa nova', bpm: 124, rows: [{ i: 'clave', hits: [0, 3, 6, 10, 13] }, { i: 'bass', hits: [0, 6, 8, 14] }, { i: 'rhs', hits: [0, 3, 6, 10, 13] }] },
    dembow: { name: 'Reggaeton dembow', bpm: 92, rows: [{ i: 'kick', hits: [0, 4, 8, 12] }, { i: 'clap', hits: [3, 6, 11, 14] }, { i: 'bass', hits: [0, 8] }, { i: 'rhl', hits: [0] }] },
    shuffle: { name: 'Blues shuffle + boogie bass', steps: 12, bpm: 104, rows: [{ i: 'boog', hits: [0, 2, 3, 5, 6, 8, 9, 11] }, { i: 'rhs', hits: [3, 9] }] },
    waltz: { name: 'Waltz (3/4)', steps: 12, bpb: 3, bpm: 120, rows: [{ i: 'bass', hits: [0] }, { i: 'rhs', hits: [4, 8] }] },
    sixeight: { name: '6/8 lilt', steps: 12, bpb: 2, bpm: 56, rows: [{ i: 'bass', hits: [0, 6] }, { i: 'arp', hits: [0, 2, 4, 6, 8, 10] }] },
    broken: { name: 'Broken chords', steps: 8, bpm: 84, rows: [{ i: 'bass', hits: [0] }, { i: 'up', hits: [0, 1, 2, 3, 4, 5, 6, 7] }] },
    alberti: { name: 'Alberti bass', steps: 8, bpm: 96, rows: [{ i: 'alb', hits: [0, 1, 2, 3, 4, 5, 6, 7] }, { i: 'rhl', hits: [0] }] },
    jazz: { name: 'Swing', steps: 12, bpm: 116, rows: [{ i: 'walk', hits: [0, 3, 6, 9] }, { i: 'rhs', hits: [0, 5] }, { i: 'click', hits: [3, 9] }] },
  };

  /* ───────────── drum loops under songs ─────────────
   * A bar of `steps` boxes stretched over the track's beats per bar; v = loudness of the row.
   * Every event a loop makes is flagged dr:1 so the player's Beat switch can mute it.
   */
  const EIGHTHS = [0, 2, 4, 6, 8, 10, 12, 14];
  const DRUMS = {
    worship: { name: 'Soft ballad beat', steps: 16, rows: [{ i: 'kick', hits: [0, 10], v: 0.75 }, { i: 'clap', hits: [4, 12], v: 0.4 }, { i: 'shaker', hits: EIGHTHS, v: 0.45 }] },
    praise: { name: 'Upbeat dance beat', steps: 16, rows: [{ i: 'kick', hits: [0, 6, 8], v: 0.9 }, { i: 'clap', hits: [4, 12], v: 0.7 }, { i: 'shaker', hits: [0, 2, 3, 4, 6, 8, 10, 11, 12, 14], v: 0.45 }] },
    highlife: { name: 'Highlife bell and drum', steps: 12, rows: [{ i: 'bell', hits: [0, 2, 4, 5, 7, 9, 11], v: 0.45 }, { i: 'kick', hits: [0, 6], v: 0.8 }, { i: 'clap', hits: [3, 9], v: 0.4 }, { i: 'shaker', hits: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], v: 0.3 }] },
    hymn: { name: 'Gentle pulse', steps: 4, rows: [{ i: 'kick', hits: [0], v: 0.6 }, { i: 'shaker', hits: [1, 2, 3], v: 0.35 }] },
    steady: { name: 'Steady beat', steps: 8, rows: [{ i: 'kick', hits: [0, 4], v: 0.75 }, { i: 'clap', hits: [2, 6], v: 0.5 }, { i: 'shaker', hits: [0, 1, 2, 3, 4, 5, 6, 7], v: 0.35 }] },
    waltz: { name: 'Waltz beat (3/4)', steps: 3, rows: [{ i: 'kick', hits: [0], v: 0.8 }, { i: 'clap', hits: [1, 2], v: 0.35 }] },
    sixeight: { name: '6/8 beat', steps: 6, rows: [{ i: 'kick', hits: [0], v: 0.8 }, { i: 'clap', hits: [3], v: 0.45 }, { i: 'shaker', hits: [0, 1, 2, 3, 4, 5], v: 0.35 }] },
  };

  function pickDrums(text, bpb = 4) {
    const t = String(text || '').toLowerCase();
    if (bpb === 3 || /3\/4|waltz/.test(t)) return 'waltz';
    if (/6\/8|12\/8/.test(t)) return 'sixeight';
    if (/highlife|bell/.test(t)) return 'highlife';
    if (/praise|dance|jama|upbeat|fast|celebrat/.test(t)) return 'praise';
    if (/hymn/.test(t)) return 'hymn';
    return 'worship';
  }

  function drumLoop(events, from, to, name, bpb, vol = 1) {
    const p = DRUMS[name];
    if (!p) throw new Error(`Unknown beat: ${name}`);
    const stepBeat = bpb / p.steps;
    for (let bar = from; bar < to - 0.001; bar += bpb) {
      p.rows.forEach((row) => row.hits.forEach((h) => {
        const t = bar + h * stepBeat;
        if (t >= to - 0.001) return;
        ev(events, t, 0.1, PERC[row.i], [], row.v * vol);
        events[events.length - 1].dr = 1;
      }));
    }
  }

  function pickGroove(text) {
    const t = String(text || '').toLowerCase();
    const rules = [
      ['strings', /strings|worship pad/],
      ['shuffle', /shuffle|boogie|12-bar|blues|rock ’n’ roll|rock 'n' roll|rock and roll/],
      ['waltz', /waltz|3\/4|in three|oom-pah-pah|minuet/],
      ['sixeight', /6\/8|lilt/],
      ['dembow', /reggaeton|dembow|dancehall/],
      ['ska', /rocksteady|\bska\b|every “&”/],
      ['reggae', /one drop|skank|reggae/],
      ['amapiano', /amapiano|afro-house|house tempo/],
      ['afrobeats', /afrobeat|afro-pop|afropop|3-3-2/],
      ['highlife', /highlife|bell/],
      ['palmwine', /palm-wine|picking|guitarist|like a guitar/],
      ['marabi', /marabi|jive|mbaqanga|kwela|chop/],
      ['soukous', /soukous|benga|lingala/],
      ['rumba', /rumba|clave/],
      ['son', /\bson\b|salsa|mambo|montuno|tumbao|guajira/],
      ['cumbia', /cumbia|güiro/],
      ['samba', /samba|carnival/],
      ['bossa', /bossa/],
      ['gospel', /gospel|spiritual|hymn|church/],
      ['jazz', /swing|jazz|standard/],
      ['alberti', /alberti/],
      ['broken', /classical|broken|arpeggi|ripple|flowing|baroque|romantic|film|sonata|nocturne|étude|etude|prelude/],
      ['lullaby', /lullaby|rocking|softly/],
      ['march', /march|footsteps|marching|anthem/],
      ['soul', /soul|motown|r&amp;b|r&b|doo-wop/],
      ['twobeat', /2 and 4|two-beat|beats 2 and 4|on 2 and 4|bouncy|call and response/],
      ['ballad', /ballad|slow|tender|one chord per bar|ring|gentle/],
      ['drive', /driving|drive|8ths|eighths|\brock\b|punk|energetic|fast/],
      ['pop', /pop|dance|disco|groove/],
    ];
    const hit = rules.find(([, re]) => re.test(t));
    return hit ? hit[0] : 'folk';
  }

  /** Map a rhythm-grid row label from the book to an instrument. */
  function instForLabel(label, color) {
    const l = String(label).toLowerCase();
    if (/string|pad/.test(l)) return 'pad';
    if (/kick|drop/.test(l)) return 'kick';
    if (/clap/.test(l)) return 'clap';
    if (/bell/.test(l)) return 'bell';
    if (/clave|castanet/.test(l)) return 'clave';
    if (/^lh chop/.test(l)) return 'lhs';
    if (/^rh one note/.test(l)) return 'rh1';
    if (/güiro|guiro/.test(l)) return 'guiro';
    if (/feet/.test(l)) return 'kick';
    if (/shuffle/.test(l)) return color === 'lh' ? 'boog' : 'click';
    if (/alberti/.test(l)) return 'alb';
    if (/fifth/.test(l)) return 'b5';
    if (/tumbao|bass|lh|root/.test(l)) return 'bass';
    if (/^up/.test(l)) return 'up';
    if (/notes/.test(l)) return 'arp';
    if (/skank|chop/.test(l)) return 'rhs';
    if (/ballad/.test(l)) return 'rhl';
    if (/driving/.test(l)) return 'rhs';
    if (/rh|chord|pushed|stab/.test(l)) return 'rh';
    return 'click';
  }

  /* ───────────── event builders ───────────── */

  const PERC = { kick: 'k', clap: 'c', bell: 'e', clave: 'v', guiro: 'g', shaker: 's', click: 'n' };
  const round = (x) => Math.round(x * 1000) / 1000;

  function ev(events, b, d, i, n, v) {
    events.push({ b: round(b), d: round(Math.max(0.05, d)), i, n: n || [], v: round(v) });
  }

  function countIn(events, marks, bpb, start = 0) {
    for (let k = 0; k < bpb; k++) {
      ev(events, start + k, 0.1, k === 0 ? 'm' : 'n', [], k === 0 ? 0.9 : 0.6);
      marks.push({ b: start + k, label: String(k + 1), sub: 'Count in…', count: true });
    }
    return start + bpb;
  }

  function clicks(events, from, beats, bpb, vol = 0.35) {
    for (let k = 0; k < beats; k++) ev(events, from + k, 0.1, k % bpb === 0 ? 'm' : 'n', [], vol);
  }

  /**
   * Play a groove over a chord list (one chord per bar).
   * opts: { start, vol, percVol, rhAsClap, noPiano, noPerc, key }
   */
  function grooveOver(events, marks, groove, chords, opts = {}) {
    const steps = groove.steps || 16;
    const bpb = groove.bpb || 4;
    const stepBeat = bpb / steps;
    const start = opts.start || 0;
    const vol = opts.vol == null ? 0.7 : opts.vol;
    const percVol = opts.percVol == null ? 0.55 : opts.percVol;
    let prev = null;
    chords.forEach((barSym, bar) => {
      const parts = barSym.split(',').map((sym) => {
        const info = chordInfo(sym);
        const rh = voiceLead(prev, info);
        prev = rh;
        return { sym, info, rh };
      });
      const partNums = opts.nums ? String(opts.nums[bar]).split(',') : [];
      const t0 = start + bar * bpb;
      if (marks) {
        parts.forEach(({ sym, info, rh }, pi) => {
          const b = t0 + (pi * bpb) / parts.length;
          marks.push(opts.markLabel
            ? { b, label: opts.markLabel, sub: 'Clap along', rh: [], lh: [] }
            : { b, label: pretty(sym), sub: partNums[pi] || '', chord: sym, rh, lh: [info.lh] });
        });
      }
      groove.rows.forEach((row) => {
        const hits = row.hits.slice().sort((a, b) => a - b);
        hits.forEach((h, hi) => {
          const { info, rh } = parts[Math.min(parts.length - 1, Math.floor((h * parts.length) / steps))];
          const next = hi + 1 < hits.length ? hits[hi + 1] : steps;
          const t = t0 + h * stepBeat;
          const span = (next - h) * stepBeat;
          const perc = PERC[row.i];
          if (perc) {
            if (!opts.noPerc) ev(events, t, 0.1, perc, [], percVol * (row.i === 'click' ? 0.7 : 1));
            return;
          }
          if (opts.noPiano) return;
          const isLH = ['bass', 'b5', 'boog', 'walk', 'alb', 'pad', 'lhs'].includes(row.i);
          if (opts.rhAsClap) {
            ev(events, t, 0.1, isLH ? 'k' : 'c', [], percVol);
            return;
          }
          switch (row.i) {
            case 'rh': ev(events, t, Math.min(span, 2) * 0.9, 'p', rh, vol * 0.8); break;
            case 'rhs': ev(events, t, Math.min(span, 0.5) * 0.6, 'p', rh, vol * 0.8); break;
            case 'rhl': ev(events, t, span * 0.98, 'p', rh, vol * 0.75); break;
            case 'rh1': ev(events, t, Math.min(span, 0.5) * 0.6, 'p', [60 + info.rootPc - (info.rootPc > 7 ? 12 : 0)], vol * 0.8); break;
            case 'lhs': ev(events, t, Math.min(span, 0.5) * 0.6, 'l', rh.map((x) => x - 12), vol * 0.7); break;
            case 'pad': ev(events, t, span * 0.99, 'w', [info.lh, ...rh], vol * 0.8); break;
            case 'arp': { const seq = [0, 1, 2, 1]; ev(events, t, span * 0.95, 'p', [rh[seq[hi % 4] % rh.length]], vol * 0.7); break; }
            case 'up': { const seq = [rh[0], rh[1], rh[2], rh[0] + 12]; ev(events, t, span * 0.95, 'p', [seq[hi % 4]], vol * 0.7); break; }
            case 'alb': { const lo = 48 + info.bassPc; const seq = [lo, lo + 7, lo + (info.rh[1] - info.rh[0]), lo + 7]; ev(events, t, span * 0.95, 'l', [seq[hi % 4]], vol * 0.6); break; }
            case 'bass': ev(events, t, Math.min(span, 2) * 0.9, 'l', [info.lh], vol * 0.85); break;
            case 'b5': ev(events, t, Math.min(span, 2) * 0.9, 'l', [info.lh + 7], vol * 0.75); break;
            case 'boog': { const beat = Math.floor(h / (steps / bpb)); ev(events, t, span * 0.9, 'l', [info.lh, info.lh + (beat % 2 ? 9 : 7)], vol * 0.75); break; }
            case 'walk': {
              const beat = Math.floor(h / (steps / bpb));
              const nextInfo = chordInfo(chords[(bar + 1) % chords.length].split(',')[0]);
              const line = [info.lh, info.lh + (info.rh[1] - info.rh[0]), info.lh + 7, nextInfo.lh + (nextInfo.lh > info.lh + 7 ? -1 : 1)];
              ev(events, t, span * 0.9, 'l', [line[beat % 4]], vol * 0.8);
              break;
            }
            default: break;
          }
        });
      });
    });
    return start + chords.length * bpb;
  }

  function blockChords(events, marks, chords, opts = {}) {
    const beats = opts.beats || 4;
    let t = opts.start || 0;
    let prev = null;
    chords.forEach((sym, i) => {
      const info = chordInfo(sym);
      const rh = opts.rootPosition ? info.rh : voiceLead(prev, info);
      const len = opts.each ? opts.each[i % opts.each.length] : beats;
      prev = rh;
      marks.push({ b: t, label: pretty(sym), sub: opts.nums ? opts.nums[i] : info.names.map(pretty).join(' · '), chord: sym, rh, lh: opts.noBass ? [] : [info.lh] });
      if (!opts.noRH) ev(events, t, len * 0.96, 'p', rh, opts.vol || 0.62);
      if (!opts.noBass) ev(events, t, len * 0.96, 'l', [info.lh], (opts.vol || 0.62) * 0.9);
      if (opts.clicks) clicks(events, t, len, 4, 0.3);
      t += len;
    });
    return t;
  }

  /** Arpeggiate each chord slowly (one note per beat), then play it together. */
  function arpThenBlock(events, marks, chords, opts = {}) {
    let t = opts.start || 0;
    chords.forEach((sym, i) => {
      const info = chordInfo(sym);
      const noteNames = info.names.map(pretty);
      info.rh.forEach((m, k) => {
        marks.push({ b: t, label: noteNames[k], sub: `${pretty(sym)} — one note at a time`, rh: [m], lh: [] });
        ev(events, t, 0.95, 'p', [m], 0.6);
        t += 1;
      });
      marks.push({ b: t, label: pretty(sym), sub: `${noteNames.join(' + ')} together${opts.nums ? ` · ${opts.nums[i]}` : ''}`, chord: sym, rh: info.rh, lh: [info.lh] });
      ev(events, t, 3.8, 'p', info.rh, 0.65);
      if (!opts.noBass) ev(events, t, 3.8, 'l', [info.lh], 0.55);
      t += 4;
    });
    return t;
  }

  /**
   * Token sequence: "[Label] C4 D4:2 C4+E4+G4:4 - -:2". Default duration = 1 beat.
   * "^F" (no time) starts a sustained background chord that lasts until the next "^" or the end.
   * opts: { start, sub, vol, melody (every note is right hand), pad: 'w' strings | 'p' soft piano | false (silent) }
   */
  function sequence(events, marks, text, opts = {}) {
    let t = opts.start || 0;
    const re = /\[([^\]]*)\]|\{([^}]*)\}|(\S+)/g;
    let m;
    let label = null;
    let sub = opts.sub || '';
    const pads = [];
    const fingers = new Map();
    const noteLabel = (list) => list.map((n) => pretty(n.replace(/-?\d$/, ''))).join(' + ');
    while ((m = re.exec(text))) {
      if (m[1] != null) { label = m[1]; continue; }
      if (m[2] != null) { sub = m[2]; continue; }
      const tok = m[3];
      if (tok === '|') continue;
      if (tok[0] === '^') { pads.push({ b: t, sym: tok.slice(1) }); continue; }
      const [body, durStr] = tok.split(':');
      const d = durStr ? Number(durStr) : 1;
      if (body === '-') {
        if (label) { marks.push({ b: t, label, sub, rh: [], lh: [] }); label = null; }
        t += d;
        continue;
      }
      let rh;
      let lh;
      let own;
      if (body[0] === '@') {
        const info = chordInfo(body.slice(1));
        rh = info.rh;
        lh = [];
        own = pretty(body.slice(1));
        marks.push({ b: t, label: label || own, sub: label ? sub : `${info.names.map(pretty).join(' · ')}${sub ? ` — ${sub}` : ''}`, chord: label && label !== own ? null : body.slice(1), rh, lh });
      } else {
        const parts = body.split('+').map((s) => s.split('/'));
        const names = parts.map(([n]) => n);
        const midis = names.map(noteToMidi);
        parts.forEach(([, f], k) => { if (f) fingers.set(midis[k], f); });
        rh = opts.hand === 'lh' ? [] : opts.melody ? midis : midis.filter((x) => x >= 60);
        lh = opts.hand === 'lh' ? midis : opts.melody ? [] : midis.filter((x) => x < 60);
        own = noteLabel(names);
        marks.push({ b: t, label: label || own, sub: label && label !== '?' ? `${own}${sub ? ` — ${sub}` : ''}` : sub, rh: label === '?' ? [] : rh, lh: label === '?' ? [] : lh });
      }
      label = null;
      const withFingers = (i, list, v) => {
        ev(events, t, d * 0.95, i, list, v);
        if (list.some((m) => fingers.has(m))) events[events.length - 1].f = list.map((m) => fingers.get(m) || '');
      };
      if (rh.length) withFingers('p', rh, opts.vol || 0.65);
      if (lh.length) withFingers('l', lh, (opts.vol || 0.65) * 0.9);
      fingers.clear();
      t += d;
    }
    if (opts.pad !== false) {
      let prev = null;
      pads.forEach((p, i) => {
        const end = i + 1 < pads.length ? pads[i + 1].b : t;
        if (end <= p.b) return;
        const info = chordInfo(p.sym);
        const rh = voiceLead(prev, info).map((x) => (x - 12 >= 52 ? x - 12 : x));
        prev = rh;
        const inst = opts.pad || 'w';
        ev(events, p.b, (end - p.b) * 0.99, inst, [info.lh - 12 >= 36 ? info.lh - 12 : info.lh, ...rh], inst === 'w' ? 0.5 : 0.24);
      });
    }
    return t;
  }

  function softChords(events, chords, bpb, start, vol = 0.25) {
    let prev = null;
    chords.forEach((sym, i) => {
      const info = chordInfo(sym);
      const rh = voiceLead(prev, info);
      prev = rh;
      ev(events, start + i * bpb, bpb * 0.95, 'p', rh.map((x) => x - 12 >= 48 ? x - 12 : x), vol);
      ev(events, start + i * bpb, bpb * 0.95, 'l', [info.lh - 12 >= 36 ? info.lh - 12 : info.lh], vol);
    });
  }

  function finish(track) {
    track.events.sort((a, b) => a.b - b.b);
    track.marks.sort((a, b) => a.b - b.b);
    if (!track.len) track.len = track.events.reduce((mx, e) => Math.max(mx, e.b + e.d), 0);
    track.len = Math.ceil(track.len - 0.01);
    return track;
  }

  /* ───────────── track compilers ───────────── */

  function grooveFromSpec(spec) {
    if (spec.grid) {
      return { name: spec.grid.title || 'Book groove', steps: spec.grid.steps || 16, bpb: spec.grid.bpb || (spec.grid.steps === 8 ? 4 : 4), bpm: spec.bpm || 96,
        rows: spec.grid.rows.map((r) => ({ i: r.i || instForLabel(r.label, r.color), hits: r.hits })) };
    }
    return GROOVES[spec.groove] || GROOVES[pickGroove(spec.groove)] || GROOVES.folk;
  }

  /** Transpose every pitch in a spec (chords, key, notes) by semitones. */
  function transposeSpec(spec, semis) {
    if (!semis) return spec;
    const newKey = spec.key ? keyName(spec.key, semis) : null;
    const flats = newKey ? FLAT_KEYS.includes(newKey) : false;
    const tc = (s) => s && s.split(/\s+/).map((c) => transposeChord(c, semis, flats)).join(' ');
    const tn = (s) => s && s.split(/(\s+)/).map((tok) => {
      const c = /^([@^])([A-G][^:\s]*)(.*)$/.exec(tok);
      if (c) return c[1] + transposeChord(c[2], semis, flats) + c[3];
      return tok.replace(/\b([A-G](?:#|b)?)(-?\d)\b/g, (x) => transposeNote(x, semis));
    }).join('');
    const out = Object.assign({}, spec, { key: newKey || spec.key, chords: tc(spec.chords) });
    if (spec.tracks) out.tracks = spec.tracks.map((t) => Object.assign({}, t, { chords: tc(t.chords), notes: tn(t.notes), key: t.key ? keyName(t.key, semis) : t.key }));
    if (spec.karaoke) {
      out.karaoke = {};
      Object.keys(spec.karaoke).forEach((k) => {
        out.karaoke[k] = spec.karaoke[k].map((ln) => Object.assign({}, ln, { chords: ln.chords.map((c) => Object.assign({}, c, { chord: transposeChord(c.chord, semis, flats) })) }));
      });
    }
    return out;
  }

  function songTracks(spec) {
    const chords = spec.chords.split(/\s+/);
    const nums = numbersFor(spec.key, chords);
    const groove = grooveFromSpec(spec);
    const bpb = groove.bpb || 4;
    const bpm = spec.bpm || groove.bpm;
    const tonic = spec.key;
    const tracks = [];

    { // Listen — full groove twice, then home chord
      const t = { name: 'Listen', desc: `The whole loop in the ${groove.name.toLowerCase()} groove — twice, then the home chord.`, bpm, bpb, events: [], marks: [] };
      let end = grooveOver(t.events, t.marks, groove, chords.concat(chords), { nums: nums.concat(nums) });
      const home = chordInfo(tonic);
      t.marks.push({ b: end, label: pretty(tonic), sub: 'Home — the end', chord: tonic, rh: home.rh, lh: [home.lh] });
      ev(t.events, end, bpb, 'p', home.rh, 0.6);
      ev(t.events, end, bpb, 'l', [home.lh], 0.55);
      end += bpb;
      t.len = end;
      tracks.push(finish(t));
    }
    { // Slow — chord by chord, one note at a time
      const uniq = [...new Set(chords)];
      const t = { name: 'Slow', desc: 'Each chord one note at a time, then all together. Copy it at the piano.', bpm: 60, bpb: 4, events: [], marks: [] };
      t.len = arpThenBlock(t.events, t.marks, uniq, { nums: uniq.map((c) => nums[chords.indexOf(c)]) });
      tracks.push(finish(t));
    }
    { // Chords — block chords with smooth voicings, 4 beats each, with count
      const t = { name: 'Chords', desc: 'The loop as block chords, four beats each, with a soft click. Say the numbers out loud.', bpm: 72, bpb: 4, events: [], marks: [] };
      t.len = blockChords(t.events, t.marks, chords.concat(chords), { nums: nums.concat(nums), clicks: true });
      tracks.push(finish(t));
    }
    { // Rhythm — clap where the hands play
      const t = { name: 'Rhythm', desc: 'Only the rhythm: claps = right hand, low knocks = left hand. Clap along before you play.', bpm, bpb, events: [], marks: [] };
      const end = grooveOver(t.events, t.marks, groove, chords, { nums, rhAsClap: true, percVol: 0.6 });
      clicks(t.events, 0, end, bpb, 0.25);
      t.len = end;
      tracks.push(finish(t));
    }
    { // Play along — count-in, then the band plays softly four times round
      const t = { name: 'Play along', desc: 'Count-in, then the groove plays four times round — quietly — so your hands can join in.', bpm: Math.round(bpm * 0.9), bpb, events: [], marks: [] };
      const s = countIn(t.events, t.marks, bpb);
      const four = chords.concat(chords, chords, chords);
      const end = grooveOver(t.events, t.marks, groove, four, { start: s, nums: nums.concat(nums, nums, nums), vol: 0.35, percVol: 0.45 });
      clicks(t.events, s, end - s, bpb, 0.2);
      t.len = end;
      tracks.push(finish(t));
    }
    return tracks;
  }

  function customTrack(tr, spec) {
    const bpb = tr.bpb || 4;
    const t = { name: tr.name, desc: tr.desc || '', bpm: tr.bpm || 80, bpb, events: [], marks: [] };
    let s = tr.countIn ? countIn(t.events, t.marks, bpb) : 0;
    const key = tr.key || spec.key || 'C';
    const chords = tr.chords ? tr.chords.split(/\s+/) : [];
    const reps = tr.repeats || 1;
    let list = [];
    for (let r = 0; r < reps; r++) list = list.concat(chords);
    const nums = tr.numbers === false ? null : (chords.length ? numbersFor(key, list) : null);
    let end = s;
    switch (tr.type) {
      case 'block': end = blockChords(t.events, t.marks, list, { start: s, beats: tr.beats || bpb, each: tr.each, nums, clicks: tr.clicks, noBass: tr.noBass, noRH: tr.noRH, rootPosition: tr.rootPosition }); break;
      case 'arp': end = arpThenBlock(t.events, t.marks, list, { start: s, nums }); break;
      case 'groove': {
        const g = grooveFromSpec(tr);
        t.bpm = tr.bpm || g.bpm;
        t.bpb = g.bpb || 4;
        if (tr.countIn) { t.events = []; t.marks = []; s = countIn(t.events, t.marks, t.bpb); }
        end = grooveOver(t.events, t.marks, g, list, { start: s, nums, rhAsClap: tr.clapOnly, noPiano: tr.noPiano, vol: tr.vol, markLabel: tr.markLabel });
        if (tr.clicks) clicks(t.events, s, end - s, t.bpb, 0.25);
        break;
      }
      case 'seq': {
        const n = tr.notes;
        for (let r = 0; r < reps; r++) end = sequence(t.events, t.marks, n, { start: end, sub: tr.sub, melody: tr.melody, hand: tr.hand, pad: tr.pad, vol: tr.vol });
        if (tr.under) softChords(t.events, tr.under.split(/\s+/), bpb, s, 0.22);
        if (tr.clicks) clicks(t.events, s, end - s, bpb, 0.25);
        break;
      }
      default: throw new Error(`Unknown track type ${tr.type}`);
    }
    if (tr.beat) {
      drumLoop(t.events, s + (tr.pickup || 0), end, tr.beat, t.bpb, tr.beatVol || 1);
      t.beat = DRUMS[tr.beat].name;
    }
    const words = tr.lyrics && spec.karaoke && spec.karaoke[tr.lyrics === true ? 'chord' : tr.lyrics];
    if (words) t.lyrics = shiftLyrics(words, s);
    t.len = end;
    return finish(t);
  }

  /** Lyric lines (beats from the start of the song) moved to where the song starts in this track. */
  function shiftLyrics(lines, by) {
    if (!by) return lines;
    return lines.map((ln) => Object.assign({}, ln, {
      b0: ln.b0 + by,
      b1: ln.b1 + by,
      chords: ln.chords.map((c) => Object.assign({}, c, { b: c.b + by })),
      words: ln.words && ln.words.map((w) => Object.assign({}, w, { b: w.b + by })),
    }));
  }

  /** Compile an entry into tracks. opts.semis transposes everything. */
  function compile(spec, opts = {}) {
    const s = transposeSpec(spec, opts.semis || 0);
    const tracks = s.tracks ? s.tracks.map((tr) => customTrack(tr, s)) : songTracks(s);
    return { spec: s, tracks };
  }

  const midiName = (m) => SHARPS[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);

  return {
    LETTERS, QUALITY, GROOVES, DRUMS, pretty, parseChord, chordInfo, numbersFor, noteToMidi, midiName,
    transposeChord, keyName, pickGroove, pickDrums, instForLabel, compile, FLAT_KEYS,
  };
});
