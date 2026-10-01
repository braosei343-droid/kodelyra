/* Kodelyra Scan & Play — page UI + Web Audio piano. */
(function () {
  'use strict';

  const DATA = window.KODELYRA_DATA;
  const M = window.KMusic;
  const app = document.getElementById('app');
  const byCode = new Map(DATA.entries.map((e) => [e.code, e]));
  const $ = (sel, el = document) => el.querySelector(sel);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* ───────────────────────── audio engine ───────────────────────── */

  const Engine = {
    ctx: null,
    unlocked: false,

    ensure() {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        this.ctx = new AC({ latencyHint: 'interactive' });
        const c = this.ctx;
        this.master = c.createGain();
        this.master.gain.value = 0.9;
        const comp = c.createDynamicsCompressor();
        comp.threshold.value = -14; comp.ratio.value = 3; comp.attack.value = 0.004; comp.release.value = 0.2;
        this.master.connect(comp).connect(c.destination);
        this.verb = c.createConvolver();
        this.verb.buffer = this.impulse(1.7);
        const wet = c.createGain(); wet.gain.value = 0.16;
        this.verb.connect(wet).connect(this.master);
        this.noise = this.makeNoise();
        this.loadPiano();
      }
      try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { /* not supported */ }
      if (!this.unlocked) {
        /* iOS: an <audio> element moves playback to the media channel so the silent switch doesn't mute it */
        const a = new Audio(silentWav());
        a.loop = true; a.volume = 0.01;
        a.play().catch(() => {});
        this.keepAlive = a;
        this.unlocked = true;
      }
      if (this.ctx.state !== 'running') this.ctx.resume();
      return this.ctx;
    },

    impulse(sec) {
      const c = this.ctx;
      const len = Math.floor(c.sampleRate * sec);
      const buf = c.createBuffer(2, len, c.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const d = buf.getChannelData(ch);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
      }
      return buf;
    },

    makeNoise() {
      const c = this.ctx;
      const buf = c.createBuffer(1, c.sampleRate, c.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      return buf;
    },

    session() {
      const g = this.ctx.createGain();
      g.connect(this.master);
      g.connect(this.verb);
      return g;
    },

    /* Recorded grand piano: Salamander Grand Piano V3 by Alexander Holm (CC BY 3.0),
       one sample every minor third from A1 to F#6 — every note is at most one semitone from a recording. */
    PIANO: [33].concat(...[2, 3, 4, 5, 6].map((o) => [0, 3, 6, 9].map((k) => 12 * (o + 1) + k))).filter((m) => m <= 90),
    samples: [],
    pianoDone: false,

    sampleUrl(m) { return `piano/${['C', 'Ds', 'Fs', 'A'][(m % 12) / 3]}${Math.floor(m / 12) - 1}.mp3`; },

    /** Start downloading on page load (no audio context needed); decoding waits for the first tap. */
    prefetch() {
      if (this.raw || !window.fetch) return;
      this.raw = this.PIANO.map((m) => fetch(this.sampleUrl(m)).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null));
    },

    loadPiano() {
      if (this.pianoLoad) return this.pianoLoad;
      this.prefetch();
      const c = this.ctx;
      const decode = (ab) => new Promise((ok) => {
        const p = c.decodeAudioData(ab, ok, () => ok(null));
        if (p && p.catch) p.catch(() => ok(null));
      });
      this.pianoLoad = Promise.all((this.raw || []).map((p, i) => p
        .then((ab) => (ab ? decode(ab) : null))
        .then((buf) => { if (buf) this.samples.push({ m: this.PIANO[i], buf, off: onsetOf(buf) }); })
        .catch(() => {})))
        .then(() => { this.pianoDone = this.samples.length > 0; });
      return this.pianoLoad;
    },

    whenPiano(ms) {
      if (this.pianoDone) return Promise.resolve();
      return Promise.race([this.loadPiano(), new Promise((r) => setTimeout(r, ms))]);
    },

    piano(bus, t, midi, dur, vel) {
      if (!this.pianoDone) { this.synthPiano(bus, t, midi, dur, vel); return; }
      const c = this.ctx;
      let s = this.samples[0];
      for (const x of this.samples) if (Math.abs(x.m - midi) < Math.abs(s.m - midi)) s = x;
      const src = c.createBufferSource();
      src.buffer = s.buf;
      src.playbackRate.value = Math.pow(2, (midi - s.m) / 12);
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = 0;
      lp.frequency.value = 1800 + vel * vel * 18000;
      const g = c.createGain();
      const level = 1.6 * vel;
      g.gain.setValueAtTime(level, t);
      g.gain.setValueAtTime(level, t + dur);
      g.gain.setTargetAtTime(0.0001, t + dur, midi < 48 ? 0.16 : 0.1);
      src.connect(lp).connect(g).connect(bus);
      src.start(t, s.off);
      src.stop(t + dur + 1);
    },

    /** Fallback tone while the recorded piano downloads (or if it can't load). */
    synthPiano(bus, t, midi, dur, vel) {
      const c = this.ctx;
      const f = 440 * Math.pow(2, (midi - 69) / 12);
      const out = c.createGain();
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = 0.4;
      const bright = Math.min(14000, f * 7 + 1500 + vel * 4500);
      lp.frequency.setValueAtTime(bright, t);
      lp.frequency.exponentialRampToValueAtTime(Math.max(350, f * 2.2), t + Math.min(3, dur + 0.6));
      const peak = 0.2 * vel * (midi < 48 ? 1.25 : midi > 76 ? 0.8 : 1);
      const decay = midi < 48 ? 1.8 : midi < 72 ? 1.2 : 0.8;
      out.gain.setValueAtTime(0.0001, t);
      out.gain.linearRampToValueAtTime(peak, t + 0.006);
      out.gain.setTargetAtTime(peak * 0.28, t + 0.008, decay * 0.3);
      out.gain.setTargetAtTime(0.0001, t + dur, 0.1);
      const stop = t + dur + 0.7;
      [[1, 1, 'triangle'], [2, 0.38, 'sine'], [3, 0.13, 'sine'], [4, 0.07, 'sine'], [5, 0.03, 'sine']].forEach(([k, amp, type]) => {
        const o = c.createOscillator();
        o.type = type;
        o.frequency.value = f * k * (1 + 0.0004 * k * k);
        const g = c.createGain();
        g.gain.value = amp;
        o.connect(g).connect(lp);
        o.start(t);
        o.stop(stop);
      });
      lp.connect(out).connect(bus);
    },

    /** Keyboard "strings" tone: slow swell, detuned saws, soft top — a warm keyboard pad. */
    strings(bus, t, midi, dur, vel) {
      const c = this.ctx;
      const f = 440 * Math.pow(2, (midi - 69) / 12);
      const out = c.createGain();
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = 0.7;
      lp.frequency.value = Math.min(4200, 900 + f * 2.5);
      const peak = 0.07 * vel * (midi < 48 ? 1.2 : 1);
      const attack = Math.min(0.35, dur * 0.3);
      out.gain.setValueAtTime(0.0001, t);
      out.gain.linearRampToValueAtTime(peak, t + attack);
      out.gain.setValueAtTime(peak, t + Math.max(attack, dur - 0.05));
      out.gain.setTargetAtTime(0.0001, t + dur, 0.25);
      const stop = t + dur + 1.4;
      const lfo = c.createOscillator();
      const depth = c.createGain();
      lfo.frequency.value = 5.2;
      depth.gain.value = f * 0.004;
      lfo.connect(depth);
      lfo.start(t);
      lfo.stop(stop);
      [-7, 0, 7].forEach((cents) => {
        const o = c.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = f;
        o.detune.value = cents;
        depth.connect(o.frequency);
        o.connect(lp);
        o.start(t);
        o.stop(stop);
      });
      lp.connect(out).connect(bus);
    },

    perc(bus, t, kind, vel) {
      const c = this.ctx;
      const g = c.createGain();
      g.connect(bus);
      const noise = (filterType, freq, q, len) => {
        const s = c.createBufferSource();
        s.buffer = this.noise;
        const f = c.createBiquadFilter();
        f.type = filterType; f.frequency.value = freq; f.Q.value = q;
        s.connect(f).connect(g);
        s.start(t, Math.random() * 0.5, len + 0.05);
        return s;
      };
      const tone = (type, freq, len, endFreq) => {
        const o = c.createOscillator();
        o.type = type;
        o.frequency.setValueAtTime(freq, t);
        if (endFreq) o.frequency.exponentialRampToValueAtTime(endFreq, t + len);
        o.connect(g);
        o.start(t);
        o.stop(t + len + 0.05);
      };
      const env = (peak, len) => {
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(peak, t + 0.002);
        g.gain.exponentialRampToValueAtTime(0.0001, t + len);
      };
      switch (kind) {
        case 'k': env(0.9 * vel, 0.35); tone('sine', 140, 0.3, 42); break;
        case 'c':
          g.gain.setValueAtTime(0.0001, t);
          [0, 0.011, 0.022].forEach((o) => { g.gain.linearRampToValueAtTime(0.55 * vel, t + o + 0.001); g.gain.exponentialRampToValueAtTime(0.08 * vel, t + o + 0.009); });
          g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
          noise('bandpass', 1400, 0.9, 0.2);
          break;
        case 's': env(0.22 * vel, 0.06); noise('highpass', 6500, 0.7, 0.07); break;
        case 'e': env(0.28 * vel, 0.3); tone('triangle', 1318, 0.3); tone('sine', 1975, 0.25); break;
        case 'v': env(0.45 * vel, 0.07); tone('triangle', 2350, 0.07); break;
        case 'g': {
          g.gain.setValueAtTime(0.0001, t);
          for (let i = 0; i < 6; i++) { g.gain.linearRampToValueAtTime(0.25 * vel, t + i * 0.022 + 0.004); g.gain.linearRampToValueAtTime(0.03 * vel, t + i * 0.022 + 0.018); }
          g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
          noise('bandpass', 3800, 1.2, 0.16);
          break;
        }
        case 'r': env(0.5 * vel, 0.05); tone('triangle', 1650, 0.04, 1100); noise('bandpass', 2600, 2, 0.03); break;
        case 'h': env(0.55 * vel, 0.16); tone('sine', 360, 0.15, 300); tone('triangle', 720, 0.05); break;
        case 'q': env(0.6 * vel, 0.24); tone('sine', 235, 0.22, 190); break;
        case 'm': env(0.35 * vel, 0.04); tone('sine', 1760, 0.04); break;
        case 'n': env(0.3 * vel, 0.035); tone('sine', 1320, 0.035); break;
        default: break;
      }
    },
  };

  /** Seconds of silence before the hammer strikes, so every note lands exactly on the beat. */
  function onsetOf(buf) {
    const d = buf.getChannelData(0);
    const n = Math.min(d.length, Math.floor(buf.sampleRate * 0.3));
    for (let i = 0; i < n; i++) if (Math.abs(d[i]) > 0.008) return Math.max(0, i / buf.sampleRate - 0.002);
    return 0;
  }

  function silentWav() {
    const n = 800;
    const buf = new Uint8Array(44 + n);
    const dv = new DataView(buf.buffer);
    const w = (o, s) => [...s].forEach((ch, i) => { buf[o + i] = ch.charCodeAt(0); });
    w(0, 'RIFF'); dv.setUint32(4, 36 + n, true); w(8, 'WAVE'); w(12, 'fmt ');
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, 8000, true); dv.setUint32(28, 8000, true); dv.setUint16(32, 1, true); dv.setUint16(34, 8, true);
    w(36, 'data'); dv.setUint32(40, n, true);
    for (let i = 0; i < n; i++) buf[44 + i] = 128;
    let s = '';
    buf.forEach((b) => { s += String.fromCharCode(b); });
    return `data:audio/wav;base64,${btoa(s)}`;
  }

  /* ───────────────────────── transport ───────────────────────── */

  const Player = {
    track: null,
    playing: false,
    loop: false,
    beat: (() => { try { return localStorage.getItem('kodelyra-beat') !== 'off'; } catch (e) { return true; } })(),
    speed: 1,
    onFrame: null,
    onEnd: null,

    spb() { return 60 / (this.track.bpm * this.speed); },
    beatAt(time) { return this.anchorBeat + (time - this.anchorTime) / this.spb(); },
    timeAt(beat) { return this.anchorTime + (beat - this.anchorBeat) * this.spb(); },

    start(track) {
      this.stop(true);
      const ctx = Engine.ensure();
      this.track = track;
      this.bus = Engine.session();
      this.anchorTime = ctx.currentTime + 0.12;
      this.anchorBeat = 0;
      this.idx = 0;
      this.offset = 0;
      this.playing = true;
      this.timer = setInterval(() => this.tick(), 25);
      this.tick();
      const frame = () => {
        if (!this.playing) return;
        const beat = this.beatAt(Engine.ctx.currentTime);
        if (this.onFrame) this.onFrame(beat < 0 ? -1 : beat - this.loopBase(beat));
        this.raf = requestAnimationFrame(frame);
      };
      this.raf = requestAnimationFrame(frame);
      wakeLock(true);
    },

    loopBase(beat) {
      if (!this.loop) return 0;
      return Math.floor(Math.max(0, beat) / this.track.len) * this.track.len;
    },

    tick() {
      if (!this.playing) return;
      const ctx = Engine.ctx;
      const horizon = this.beatAt(ctx.currentTime + 0.18);
      const ev = this.track.events;
      for (;;) {
        if (this.idx >= ev.length) {
          if (this.loop) { this.idx = 0; this.offset += this.track.len; continue; }
          if (this.beatAt(ctx.currentTime) > this.track.len + 0.3) this.finish();
          break;
        }
        const e = ev[this.idx];
        const b = this.offset + e.b;
        if (b > horizon) break;
        if (e.dr && !this.beat) { this.idx++; continue; }
        const t = Math.max(ctx.currentTime, this.timeAt(b));
        const dur = e.d * this.spb();
        if (e.i === 'p' || e.i === 'l') e.n.forEach((m) => Engine.piano(this.bus, t, m, dur, e.v));
        else if (e.i === 'w') e.n.forEach((m) => Engine.strings(this.bus, t, m, dur, e.v));
        else Engine.perc(this.bus, t, e.i, e.v);
        this.idx++;
      }
    },

    setSpeed(s) {
      if (this.playing) {
        const now = Engine.ctx.currentTime;
        const beat = this.beatAt(now);
        this.speed = s;
        this.anchorBeat = beat;
        this.anchorTime = now;
      } else this.speed = s;
    },

    finish() {
      this.stop();
      if (this.onEnd) this.onEnd();
    },

    stop(silent) {
      if (!this.playing) return;
      this.playing = false;
      clearInterval(this.timer);
      cancelAnimationFrame(this.raf);
      const bus = this.bus;
      if (bus) {
        bus.gain.setTargetAtTime(0.0001, Engine.ctx.currentTime, 0.04);
        setTimeout(() => bus.disconnect(), 400);
      }
      wakeLock(false);
      if (!silent && this.onFrame) this.onFrame(-1);
    },
  };

  let lock = null;
  function wakeLock(on) {
    if (!('wakeLock' in navigator)) return;
    if (on && !lock) navigator.wakeLock.request('screen').then((l) => { lock = l; }).catch(() => {});
    if (!on && lock) { lock.release().catch(() => {}); lock = null; }
  }

  /* ───────────────────────── keyboard ───────────────────────── */

  const isBlack = (m) => [1, 3, 6, 8, 10].includes(((m % 12) + 12) % 12);

  const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

  function keyboardSVG(lo, hi, flats) {
    while (lo % 12 !== 0 && lo % 12 !== 5) lo--;
    while (hi % 12 !== 11 && hi % 12 !== 4) hi++;
    const whites = [];
    for (let m = lo; m <= hi; m++) if (!isBlack(m)) whites.push(m);
    const W = 34;
    const H = 150;
    let wk = '';
    let bk = '';
    whites.forEach((m, i) => {
      const name = M.midiName(m).replace(/\d+$/, '');
      wk += `<g class="key white" data-m="${m}"><rect x="${i * W}" y="0" width="${W}" height="${H}" rx="4"/><text x="${i * W + W / 2}" y="${H - 12}">${name === 'C' ? M.midiName(m) : name}</text><text class="fing" x="${i * W + W / 2}" y="${H - 40}"></text></g>`;
      if (m + 1 <= hi && isBlack(m + 1)) {
        const nm = M.pretty(flats ? FLAT_NAMES[(m + 1) % 12] : M.midiName(m + 1).replace(/\d+$/, ''));
        bk += `<g class="key black" data-m="${m + 1}"><rect x="${i * W + W * 0.66}" y="0" width="${W * 0.68}" height="${H * 0.62}" rx="3"/><text x="${i * W + W}" y="${H * 0.62 - 10}">${nm}</text><text class="fing" x="${i * W + W}" y="${H * 0.62 - 30}"></text></g>`;
      }
    });
    return `<svg class="kb" viewBox="-1 -1 ${whites.length * W + 2} ${H + 2}" role="img" aria-label="Piano keyboard showing the notes being played">${wk}${bk}</svg>`;
  }

  function rangeOf(tracks) {
    let lo = 60;
    let hi = 72;
    tracks.forEach((t) => t.events.forEach((e) => e.n.forEach((m) => { lo = Math.min(lo, m); hi = Math.max(hi, m); })));
    if (hi - lo < 24) hi = lo + 24;
    return [lo, hi];
  }

  /* ───────────────────────── views ───────────────────────── */

  function parseRoute() {
    const raw = decodeURIComponent(location.search.replace(/^\?/, '').split('&')[0] || '').trim();
    const q = raw.replace(/^s=/, '').toLowerCase();
    if (!q) return { home: true };
    if (/^\d{1,3}p$/.test(q)) return { code: q.slice(0, -1).padStart(3, '0'), track: 'Play along' };
    if (/^\d{1,3}$/.test(q)) return { code: q.padStart(3, '0') };
    return { code: q };
  }

  function go(code) {
    Player.stop(true);
    history.pushState(null, '', code ? `?${code}` : location.pathname);
    render();
    window.scrollTo(0, 0);
  }

  function linkTo(e) {
    return `<a class="row" href="?${e.code}" data-go="${e.code}"><span class="row-ref">${esc(e.kind === 'song' ? `#${e.code}` : e.ref.replace('Chapter ', 'Ch '))}</span><span class="row-title">${e.flag ? `${e.flag} ` : ''}${esc(e.title)}</span><span class="row-sub">${esc(e.kind === 'song' ? (e.artist || '') : (e.sub || ''))}</span></a>`;
  }

  function home() {
    document.title = 'Kodelyra · Scan & Play';
    const lessons = DATA.entries.filter((e) => e.kind === 'lesson' && !e.parent);
    const chapters = DATA.entries.filter((e) => e.kind === 'chapter');
    const songs = DATA.entries.filter((e) => e.kind === 'song');
    const groups = [];
    songs.forEach((s) => {
      const g = s.group || 'Songs';
      let grp = groups.find((x) => x.name === g);
      if (!grp) { grp = { name: g, items: [] }; groups.push(grp); }
      grp.items.push(s);
    });
    app.innerHTML = `
      <header class="top"><div class="brand"><span class="logo">K</span> Kodelyra <b>Scan &amp; Play</b></div></header>
      <section class="hero">
        <h1>Hear it. Slow it down. Play along.</h1>
        <p>Every QR code in <em>Play Piano Songs — Book 1</em> opens a page here. Tap a lesson or song, press <strong>Play</strong>, and watch the keys light up.</p>
        <ol class="how"><li><strong>Listen</strong> — hear the example</li><li><strong>Slow</strong> — chord by chord, note by note</li><li><strong>Rhythm</strong> — clap it first</li><li><strong>Play along</strong> — join in, at your speed</li></ol>
        <p class="tip">🔊 Turn the volume up. On iPhone, also flip the silent switch off if you hear nothing.</p>
      </section>
      <label class="search"><span>Find a song or lesson</span><input id="q" type="search" placeholder="Song number, title, artist or country…" autocomplete="off"></label>
      <div id="results"></div>
      <details open><summary>Levels 1–2 · Lessons</summary><div class="list">${lessons.map(linkTo).join('')}</div></details>
      ${groups.map((g) => `<details><summary>${esc(g.name)} <small>${g.items.length}</small></summary><div class="list">${g.items.map(linkTo).join('')}</div></details>`).join('')}
      <details><summary>Levels 3–5 · Chapter sounds</summary><div class="list">${chapters.map(linkTo).join('')}</div></details>
      <footer class="foot">Kodelyra · Play Piano Songs — Book 1 · Arrangements are the book’s own. Piano sound: Salamander Grand Piano by Alexander Holm (CC BY 3.0). Works offline after your first visit.</footer>`;
    const input = $('#q');
    const results = $('#results');
    input.addEventListener('input', () => {
      const v = input.value.trim().toLowerCase();
      if (!v) { results.innerHTML = ''; return; }
      const num = v.replace(/^#/, '');
      const hits = DATA.entries.filter((e) => (/^\d+$/.test(num) && e.kind === 'song' && String(e.n) === String(Number(num)))
        || [e.title, e.artist, e.country, e.ref, e.style].some((x) => x && x.toLowerCase().includes(v))).slice(0, 30);
      results.innerHTML = hits.length ? `<div class="list">${hits.map(linkTo).join('')}</div>` : '<p class="none">No match — try a song number like 57.</p>';
    });
  }

  function entryView(route) {
    const entry = byCode.get(route.code);
    if (!entry) {
      app.innerHTML = `<header class="top"><a class="back" href="./" data-go="">← All songs &amp; lessons</a></header><section class="hero"><h1>Page not found</h1><p>We couldn’t find “${esc(route.code)}”. Check the code printed under the QR, or pick from the list.</p><p><a class="btn" href="./" data-go="">Open the song list</a></p></section>`;
      return;
    }
    let semis = 0;
    let compiled = M.compile(entry, { semis });
    let trackIdx = Math.max(0, compiled.tracks.findIndex((t) => t.name === route.track));
    const main = DATA.entries.filter((e) => !e.parent);
    const i = main.indexOf(entry.parent ? byCode.get(entry.parent) : entry);
    const prev = main[i - 1];
    const next = main[i + 1];
    const set = entry.set;
    const setNav = set ? `<nav class="set" aria-label="${esc(set.label)}">
        <div class="set-head"><b>${esc(set.label)}</b>${entry.parent ? `<a href="?${set.hub}" data-go="${set.hub}">All songs →</a>` : ''}</div>
        <div class="set-list">${set.items.map((s) => `<a class="set-song${s.code === entry.code ? ' on' : ''}" href="?${s.code}" data-go="${s.code}"${s.code === entry.code ? ' aria-current="page"' : ''}><b>${esc(s.title)}</b><small>${esc(s.by)}</small></a>`).join('')}</div>
      </nav>` : '';
    document.title = `${entry.ref} · ${entry.title} — Kodelyra Scan & Play`;
    const isSong = entry.kind === 'song';
    const yt = isSong ? `https://www.youtube.com/results?search_query=${encodeURIComponent(`${entry.title} ${entry.country === 'Ghana' ? 'Twi song Ghana' : /traditional/i.test(entry.artist || '') ? 'traditional song' : entry.artist || ''}`)}` : null;

    app.innerHTML = `
      <header class="top"><a class="back" href="./" data-go="">← All songs &amp; lessons</a><span class="brand small"><span class="logo">K</span> Scan &amp; Play</span></header>
      <section class="entry-head">
        <p class="ref">${esc(entry.ref)}${entry.group ? ` · ${esc(entry.group)}` : ''}</p>
        <h1>${entry.flag ? `<span class="flag">${entry.flag}</span> ` : ''}${esc(entry.title)}</h1>
        <p class="meta">${esc([entry.artist, entry.country, entry.style].filter(Boolean).join(' · ') || entry.sub || '')}</p>
      </section>
      ${setNav}
      <section class="stage">
        <div class="now"><div class="now-label" id="nowLabel">Press play</div><div class="now-sub" id="nowSub">${esc(compiled.tracks[trackIdx].desc)}</div></div>
        <div class="kb-wrap" id="kb"></div>
        <div class="chips" id="chips"></div>
        <div class="progress"><div id="bar"></div></div>
      </section>
      <section class="lyrics" id="lyrics" hidden></section>
      <section class="guide" id="guide" hidden></section>
      <nav class="tracks" id="tracks" aria-label="Choose what to hear"></nav>
      <section class="transport">
        <button class="play" id="play" aria-label="Play">▶ Play</button>
        <div class="toggles">
          <label class="toggle" id="beatWrap" hidden><input type="checkbox" id="beat"${Player.beat ? ' checked' : ''}> 🥁 Beat</label>
          <label class="toggle"><input type="checkbox" id="loop"> Loop</label>
        </div>
      </section>
      <section class="controls">
        <label>Speed <output id="speedOut">100%</output><input id="speed" type="range" min="40" max="130" step="5" value="100"></label>
        <div class="transpose"><span>Key</span><button id="down" aria-label="Transpose down">−</button><output id="keyOut"></output><button id="up" aria-label="Transpose up">+</button></div>
      </section>
      ${isSong ? `<section class="info">
        <div class="loopline"><b>${entry.lyrics ? 'The chords' : 'The loop'}</b> ${esc(entry.chords.split(' ').map(M.pretty).join(' → '))}</div>
        ${entry.lyrics && !entry.karaoke ? `<div class="card"><h3>Words</h3>${entry.lyrics.map(([tw, en]) => `<p><b>${esc(tw)}</b><br><i>${esc(en)}</i></p>`).join('')}</div>` : ''}
        ${entry.family ? `<div class="card"><h3>Song family</h3><p>${esc(entry.family)}</p></div>` : ''}
        ${entry.rhythm ? `<div class="card"><h3>Rhythm (from the book)</h3><p>${entry.rhythm}</p></div>` : ''}
        ${entry.fact ? `<div class="card"><h3>Did you know?</h3><p>${entry.fact}</p></div>` : ''}
        <a class="btn outline" href="${yt}" target="_blank" rel="noopener">▶ ${entry.lyrics ? 'Hear it sung (YouTube search)' : 'Hear the original recording (YouTube)'}</a>
        <p class="small-note">${entry.lyrics ? 'The player plays the book’s version in C. Use Key − / + to move it to your singer’s key.' : 'The player uses the book’s simplified piano version so you can hear exactly what to play. The original recording opens on YouTube.'}</p>
      </section>` : ''}
      ${entry.listen ? `<section class="info"><div class="card"><h3>Hear the songs</h3>${entry.listen.map((s) => `<p><a class="btn outline" href="https://www.youtube.com/results?search_query=${encodeURIComponent(`${s.title} ${s.artist}`)}" target="_blank" rel="noopener">▶ ${esc(s.title)} — ${esc(s.artist)}</a></p>`).join('')}<p class="small-note">Recordings open on YouTube. The player plays the book’s practice loop in C — use Key − / + until it matches the recording.</p></div></section>` : ''}
      <nav class="pager">${prev ? `<a href="?${prev.code}" data-go="${prev.code}">← ${esc(prev.ref)}</a>` : '<span></span>'}${next ? `<a href="?${next.code}" data-go="${next.code}">${esc(next.ref)} →</a>` : '<span></span>'}</nav>
      <p class="tip center">🔊 No sound? Turn the volume up — on iPhone, flip the silent switch off.</p>`;

    const playBtn = $('#play');
    const nowLabel = $('#nowLabel');
    const nowSub = $('#nowSub');
    const bar = $('#bar');
    let keys = new Map();
    let lit = new Set();
    let lastMark = null;

    function drawKeyboard() {
      const [lo, hi] = rangeOf(entry.kb === 'track' ? [compiled.tracks[trackIdx]] : compiled.tracks);
      const spec = compiled.spec;
      const key = (spec.tracks && spec.tracks[trackIdx] && spec.tracks[trackIdx].key) || spec.key;
      $('#kb').innerHTML = keyboardSVG(lo, hi, M.FLAT_KEYS.includes(key));
      keys = new Map([...$('#kb').querySelectorAll('.key')].map((k) => [Number(k.dataset.m), k]));
      lit = new Set();
    }

    function drawChips() {
      const t = compiled.tracks[trackIdx];
      const seen = [];
      t.marks.forEach((mk) => { if (mk.chord && !seen.includes(mk.chord)) seen.push(mk.chord); });
      const nums = entry.key && seen.length ? M.numbersFor(compiled.spec.key || 'C', seen) : [];
      $('#chips').innerHTML = seen.slice(0, 10).map((c, k) => `<span class="chip" data-chord="${esc(c)}">${esc(M.pretty(c))}${nums[k] && entry.kind === 'song' ? `<small>${nums[k]}</small>` : ''}</span>`).join('');
    }

    /* Words with each chord printed over the syllable where it changes; lit as the track plays. */
    let ly = null;

    function lyricLineHTML(ln, li) {
      const chordTag = (ci) => `<b class="ly-chord" data-c="${li}-${ci}">${esc(M.pretty(ln.chords[ci].chord))}</b>`;
      let body;
      if (ln.words && ln.words.length) {
        const at = ln.words.map(() => []);
        ln.chords.forEach((c, ci) => {
          let k = 0;
          ln.words.forEach((w, wi) => { if (w.b <= c.b + 0.001) k = wi; });
          at[k].push(ci);
        });
        const groups = [];
        ln.words.forEach((w, wi) => {
          const syl = `<span class="ly-syl" data-w="${li}-${wi}"><span class="ly-c">${at[wi].map(chordTag).join(' ')}</span><span class="ly-t">${esc(w.t)}</span></span>`;
          if (wi > 0 && ln.words[wi - 1].join) groups[groups.length - 1] += syl;
          else groups.push(syl);
        });
        body = `<div class="ly-words">${groups.map((g) => `<span class="ly-word">${g}</span>`).join('')}</div>`;
      } else {
        body = `<div class="ly-chords">${ln.chords.map((c, ci) => chordTag(ci)).join('')}</div>${ln.text ? `<div class="ly-text">${esc(ln.text)}</div>` : ''}`;
      }
      return `<div class="ly-line" data-l="${li}">${ln.label ? `<div class="ly-label">${esc(ln.label)}</div>` : ''}${body}${ln.en ? `<div class="ly-en">${esc(ln.en)}</div>` : ''}</div>`;
    }

    function drawLyrics() {
      const t = compiled.tracks[trackIdx];
      const el = $('#lyrics');
      if (!t.lyrics) { el.hidden = true; el.innerHTML = ''; ly = null; return; }
      el.hidden = false;
      el.innerHTML = `<h3>Words &amp; chords <small>The word and chord light up as they play</small></h3><div class="ly-scroll" id="lyScroll">${t.lyrics.map(lyricLineHTML).join('')}</div>`;
      const chords = [];
      t.lyrics.forEach((ln, li) => ln.chords.forEach((c, ci) => chords.push({ b: c.b, key: `${li}-${ci}` })));
      ly = {
        lines: t.lyrics,
        chords,
        scroll: $('#lyScroll'),
        lineEls: [...el.querySelectorAll('.ly-line')],
        wordEls: new Map([...el.querySelectorAll('.ly-syl')].map((s) => [s.dataset.w, s])),
        chordEls: new Map([...el.querySelectorAll('.ly-chord')].map((s) => [s.dataset.c, s])),
        line: -2, word: null, chord: null,
      };
    }

    function lyricFrame(beat) {
      if (!ly) return;
      let li = -1;
      let wi = -1;
      let ck = null;
      if (beat >= 0) {
        ly.lines.forEach((ln, k) => { if (ln.b0 <= beat + 0.01) li = k; });
        const ln = ly.lines[li];
        if (ln && ln.words && beat < ln.b1) ln.words.forEach((w, k) => { if (w.b <= beat + 0.01) wi = k; });
        ly.chords.forEach((c) => { if (c.b <= beat + 0.01) ck = c.key; });
      }
      if (li !== ly.line) {
        ly.lineEls.forEach((el, k) => { el.classList.toggle('on', k === li); el.classList.toggle('done', k < li); });
        ly.line = li;
        const el = ly.lineEls[Math.max(0, li)];
        if (el) ly.scroll.scrollTo({ top: Math.max(0, el.offsetTop - 8), behavior: li < 0 ? 'auto' : 'smooth' });
      }
      const wkey = li >= 0 && wi >= 0 ? `${li}-${wi}` : null;
      if (wkey !== ly.word) {
        ly.wordEls.forEach((el, key) => {
          const [l, w] = key.split('-').map(Number);
          el.classList.toggle('ly-now', key === wkey);
          el.classList.toggle('sung', l === li && w < wi);
        });
        ly.word = wkey;
      }
      if (ck !== ly.chord) {
        if (ly.chord && ly.chordEls.get(ly.chord)) ly.chordEls.get(ly.chord).classList.remove('ly-now');
        if (ck && ly.chordEls.get(ck)) ly.chordEls.get(ck).classList.add('ly-now');
        ly.chord = ck;
      }
    }

    /* Chord guide for songs without printed words: the bars from the book, lit beat by beat. */
    let gd = null;

    function drawGuide() {
      const t = compiled.tracks[trackIdx];
      const el = $('#guide');
      const spans = [];
      t.marks.forEach((mk) => { if (mk.chord) spans.push({ b: mk.b, chord: mk.chord, num: mk.sub || '' }); });
      if (!entry.guide || t.lyrics || spans.length < 2) { el.hidden = true; el.innerHTML = ''; gd = null; return; }
      spans.forEach((s, k) => { s.e = k + 1 < spans.length ? spans[k + 1].b : t.len; });
      const bpb = t.bpb || 4;
      const start = spans[0].b;
      const nBars = Math.ceil((t.len - start) / bpb - 0.001);
      let html = '';
      for (let bar = 0; bar < nBars; bar++) {
        const b0 = start + bar * bpb;
        const b1 = b0 + bpb;
        const segs = spans.map((s, k) => ({ s, k, from: Math.max(s.b, b0), to: Math.min(s.e, b1) })).filter((x) => x.to - x.from > 0.001);
        const cells = segs.map(({ s, k, from, to }) => `<span class="gd-seg${from > s.b + 0.001 ? ' cont' : ''}" data-k="${k}" style="flex-grow:${to - from}"><b>${esc(M.pretty(s.chord))}</b><small>${esc(s.num)}</small></span>`).join('');
        const dots = Array.from({ length: bpb }, (_, j) => `<i data-b="${b0 + j}"></i>`).join('');
        html += `<div class="gd-bar" data-bar="${bar}"><div class="gd-segs">${cells}</div><div class="gd-dots">${dots}</div></div>`;
      }
      el.hidden = false;
      el.innerHTML = `<h3>Chord guide <small>Follow the bars — change chord when the colour moves</small></h3>
        <div class="gd-count"><div class="gd-beat"><span>Beat</span><b id="gdBeat">–</b><span>of ${bpb}</span></div><div class="gd-next" id="gdNext">Press play</div></div>
        <div class="gd-grid">${html}</div>`;
      gd = {
        spans, bpb, start, len: t.len,
        segEls: [...el.querySelectorAll('.gd-seg')],
        barEls: [...el.querySelectorAll('.gd-bar')],
        dotEls: [...el.querySelectorAll('.gd-dots i')],
        beatEl: $('#gdBeat'), nextEl: $('#gdNext'),
        k: -2, beat: -2, next: '',
      };
    }

    function guideFrame(beat) {
      if (!gd) return;
      let k = -1;
      if (beat >= 0) gd.spans.forEach((s, i) => { if (s.b <= beat + 0.01) k = i; });
      const whole = beat >= gd.start ? Math.floor(beat - gd.start + 0.01) : -1;
      if (k !== gd.k) {
        gd.segEls.forEach((el) => el.classList.toggle('now', Number(el.dataset.k) === k));
        gd.k = k;
      }
      if (whole !== gd.beat) {
        const bar = whole >= 0 ? Math.floor(whole / gd.bpb) : -1;
        gd.barEls.forEach((el, i) => { el.classList.toggle('on', i === bar); el.classList.toggle('done', i < bar); });
        const abs = gd.start + whole;
        gd.dotEls.forEach((el) => el.classList.toggle('hit', whole >= 0 && Number(el.dataset.b) === abs));
        gd.beatEl.textContent = whole >= 0 ? String((whole % gd.bpb) + 1) : '–';
        gd.beat = whole;
      }
      let next = beat < 0 ? (Player.playing ? 'Get ready…' : 'Press play') : '';
      if (beat >= 0 && k >= 0) {
        const wrap = !gd.spans[k + 1] && Player.loop;
        const nx = wrap ? gd.spans[0] : gd.spans[k + 1];
        const left = nx ? Math.ceil((wrap ? gd.len + nx.b : nx.b) - beat - 0.01) : 0;
        next = nx ? `Next: <b>${esc(M.pretty(nx.chord))}</b>${nx.num ? ` <small>${esc(nx.num)}</small>` : ''} in ${left} beat${left === 1 ? '' : 's'}` : 'Last chord — hold it';
        const nk = wrap ? 0 : k + 1;
        gd.segEls.forEach((el) => el.classList.toggle('soon', !!nx && left <= 1 && Number(el.dataset.k) === nk));
      }
      if (next !== gd.next) { gd.nextEl.innerHTML = next; gd.next = next; }
    }

    function drawTracks() {
      $('#tracks').innerHTML = compiled.tracks.map((t, k) => `<button class="${k === trackIdx ? 'on' : ''}" data-k="${k}">${esc(t.name)}</button>`).join('');
      $('#beatWrap').hidden = !compiled.tracks[trackIdx].beat;
      $('#beatWrap').title = compiled.tracks[trackIdx].beat || '';
      $('#keyOut').textContent = compiled.spec.key ? M.pretty(compiled.spec.key) : (semis ? `${semis > 0 ? '+' : ''}${semis}` : 'C');
    }

    function setLit(on, fingers = new Map()) {
      const fing = (k, f) => { const el = k.querySelector('.fing'); if (el) el.textContent = f || ''; };
      lit.forEach((m) => { if (!on.has(m) && keys.get(m)) { keys.get(m).classList.remove('rh', 'lh'); fing(keys.get(m), ''); } });
      on.forEach((val, m) => { const k = keys.get(m); if (k) { k.classList.remove('rh', 'lh'); k.classList.add(val); fing(k, fingers.get(m)); } });
      lit = new Set(on.keys());
    }

    function frame(beat) {
      const t = compiled.tracks[trackIdx];
      if (beat < 0) {
        setLit(new Map());
        bar.style.width = '0%';
        playBtn.textContent = Player.playing ? '■ Stop' : '▶ Play';
        playBtn.classList.toggle('stop', Player.playing);
        nowLabel.textContent = Player.playing ? '…' : 'Press play';
        nowSub.textContent = t.desc;
        document.querySelectorAll('.chip.on').forEach((c) => c.classList.remove('on'));
        lastMark = null;
        lyricFrame(-1);
        guideFrame(-1);
        return;
      }
      lyricFrame(beat);
      guideFrame(beat);
      const on = new Map();
      const fingers = new Map();
      t.events.forEach((e) => {
        if ((e.i === 'p' || e.i === 'l') && beat >= e.b && beat < e.b + Math.max(e.d, 0.18)) {
          e.n.forEach((m, k) => {
            on.set(m, e.i === 'l' || m < 60 ? 'lh' : 'rh');
            if (e.f && !semis) fingers.set(m, e.f[k]);
          });
        }
      });
      setLit(on, fingers);
      let mk = null;
      for (let k = 0; k < t.marks.length; k++) { if (t.marks[k].b <= beat + 0.01) mk = t.marks[k]; else break; }
      if (mk !== lastMark) {
        lastMark = mk;
        nowLabel.textContent = mk ? mk.label : '…';
        nowSub.textContent = mk ? (mk.sub || '') : '';
        document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', !!mk && c.dataset.chord === mk.chord));
      }
      bar.style.width = `${Math.min(100, (beat / t.len) * 100)}%`;
    }

    function play() {
      Engine.ensure();
      if (Engine.pianoDone) { startTrack(); return; }
      if (playBtn.disabled) return;
      playBtn.textContent = 'Loading piano…';
      playBtn.disabled = true;
      Engine.whenPiano(3000).then(() => { playBtn.disabled = false; startTrack(); });
    }

    function startTrack() {
      const t = compiled.tracks[trackIdx];
      Player.loop = $('#loop').checked;
      Player.onFrame = frame;
      Player.onEnd = () => frame(-1);
      Player.start(t);
      playBtn.textContent = '■ Stop';
      playBtn.classList.add('stop');
      if ('mediaSession' in navigator && window.MediaMetadata) {
        navigator.mediaSession.metadata = new MediaMetadata({ title: `${entry.title} — ${t.name}`, artist: 'Kodelyra Scan & Play', album: entry.ref });
      }
    }

    function recompile() {
      const wasPlaying = Player.playing;
      Player.stop(true);
      compiled = M.compile(entry, { semis });
      drawKeyboard(); drawChips(); drawTracks(); drawLyrics(); drawGuide();
      frame(-1);
      if (wasPlaying) play();
    }

    drawKeyboard(); drawChips(); drawTracks(); drawLyrics(); drawGuide();

    playBtn.addEventListener('click', () => { if (Player.playing) { Player.stop(); } else play(); });
    $('#tracks').addEventListener('click', (ev) => {
      const b = ev.target.closest('button');
      if (!b) return;
      trackIdx = Number(b.dataset.k);
      drawKeyboard();
      drawTracks(); drawChips(); drawLyrics(); drawGuide();
      frame(-1);
      play();
    });
    $('#loop').addEventListener('change', (ev) => { Player.loop = ev.target.checked; });
    $('#beat').addEventListener('change', (ev) => {
      Player.beat = ev.target.checked;
      try { localStorage.setItem('kodelyra-beat', Player.beat ? 'on' : 'off'); } catch (e) { /* private mode */ }
    });
    $('#speed').addEventListener('input', (ev) => {
      const s = Number(ev.target.value) / 100;
      $('#speedOut').textContent = `${ev.target.value}%`;
      Player.setSpeed(s);
    });
    $('#up').addEventListener('click', () => { semis = semis >= 6 ? -5 : semis + 1; recompile(); });
    $('#down').addEventListener('click', () => { semis = semis <= -5 ? 6 : semis - 1; recompile(); });
    frame(-1);
  }

  function render() {
    const route = parseRoute();
    if (route.home) home(); else entryView(route);
  }

  document.addEventListener('click', (ev) => {
    const a = ev.target.closest('[data-go]');
    if (!a || ev.metaKey || ev.ctrlKey) return;
    ev.preventDefault();
    go(a.dataset.go);
  });
  window.addEventListener('popstate', () => { Player.stop(true); render(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) Player.stop(); });

  render();
  Engine.prefetch();

  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
