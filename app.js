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

    piano(bus, t, midi, dur, vel) {
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

    /** Keyboard "strings" tone: slow swell, detuned saws, soft top — the Ghanaian worship pad. */
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
        case 'm': env(0.35 * vel, 0.04); tone('sine', 1760, 0.04); break;
        case 'n': env(0.3 * vel, 0.035); tone('sine', 1320, 0.035); break;
        default: break;
      }
    },
  };

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

  function keyboardSVG(lo, hi) {
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
      wk += `<g class="key white" data-m="${m}"><rect x="${i * W}" y="0" width="${W}" height="${H}" rx="4"/><text x="${i * W + W / 2}" y="${H - 12}">${name === 'C' ? M.midiName(m) : name}</text></g>`;
      if (m + 1 <= hi && isBlack(m + 1)) {
        const nm = M.pretty(M.midiName(m + 1).replace(/\d+$/, ''));
        bk += `<g class="key black" data-m="${m + 1}"><rect x="${i * W + W * 0.66}" y="0" width="${W * 0.68}" height="${H * 0.62}" rx="3"/><text x="${i * W + W}" y="${H * 0.62 - 10}">${nm}</text></g>`;
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
    const lessons = DATA.entries.filter((e) => e.kind === 'lesson');
    const chapters = DATA.entries.filter((e) => e.kind === 'chapter');
    const songs = DATA.entries.filter((e) => e.kind === 'song');
    const groups = [];
    songs.forEach((s) => {
      const g = s.n <= 10 ? 'Songs 1–10 · First adventures' : (s.group || 'Songs');
      let grp = groups.find((x) => x.name === g);
      if (!grp) { grp = { name: g, items: [] }; groups.push(grp); }
      grp.items.push(s);
    });
    app.innerHTML = `
      <header class="top"><div class="brand"><span class="logo">K</span> Kodelyra <b>Scan &amp; Play</b></div></header>
      <section class="hero">
        <h1>Hear it. Slow it down. Play along.</h1>
        <p>Every QR code in <em>Play 200 Songs on Piano — Book 1</em> opens a page here. Tap a lesson or song, press <strong>Play</strong>, and watch the keys light up.</p>
        <ol class="how"><li><strong>Listen</strong> — hear the example</li><li><strong>Slow</strong> — chord by chord, note by note</li><li><strong>Rhythm</strong> — clap it first</li><li><strong>Play along</strong> — join in, at your speed</li></ol>
        <p class="tip">🔊 Turn the volume up. On iPhone, also flip the silent switch off if you hear nothing.</p>
      </section>
      <label class="search"><span>Find a song or lesson</span><input id="q" type="search" placeholder="Song number, title, artist or country…" autocomplete="off"></label>
      <div id="results"></div>
      <details open><summary>Levels 1–2 · Lessons</summary><div class="list">${lessons.map(linkTo).join('')}</div></details>
      ${groups.map((g) => `<details><summary>${esc(g.name)} <small>${g.items.length}</small></summary><div class="list">${g.items.map(linkTo).join('')}</div></details>`).join('')}
      <details><summary>Levels 3–5 · Chapter sounds</summary><div class="list">${chapters.map(linkTo).join('')}</div></details>
      <footer class="foot">Kodelyra · Play 200 Songs on Piano — Book 1 · Sounds are the book’s own piano arrangements, generated in your browser. Works offline after your first visit.</footer>`;
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
    const i = DATA.entries.indexOf(entry);
    const prev = DATA.entries[i - 1];
    const next = DATA.entries[i + 1];
    document.title = `${entry.ref} · ${entry.title} — Kodelyra Scan & Play`;
    const isSong = entry.kind === 'song';
    const yt = isSong ? `https://www.youtube.com/results?search_query=${encodeURIComponent(`${entry.title} ${entry.country === 'Ghana' ? 'Ghana gospel chorus' : /traditional/i.test(entry.artist || '') ? 'traditional song' : entry.artist || ''}`)}` : null;

    app.innerHTML = `
      <header class="top"><a class="back" href="./" data-go="">← All songs &amp; lessons</a><span class="brand small"><span class="logo">K</span> Scan &amp; Play</span></header>
      <section class="entry-head">
        <p class="ref">${esc(entry.ref)}${entry.group ? ` · ${esc(entry.group)}` : ''}</p>
        <h1>${entry.flag ? `<span class="flag">${entry.flag}</span> ` : ''}${esc(entry.title)}</h1>
        <p class="meta">${esc([entry.artist, entry.country, entry.style].filter(Boolean).join(' · ') || entry.sub || '')}</p>
      </section>
      <section class="stage">
        <div class="now"><div class="now-label" id="nowLabel">Press play</div><div class="now-sub" id="nowSub">${esc(compiled.tracks[trackIdx].desc)}</div></div>
        <div class="kb-wrap" id="kb"></div>
        <div class="chips" id="chips"></div>
        <div class="progress"><div id="bar"></div></div>
      </section>
      <nav class="tracks" id="tracks" aria-label="Choose what to hear"></nav>
      <section class="transport">
        <button class="play" id="play" aria-label="Play">▶ Play</button>
        <label class="toggle"><input type="checkbox" id="loop"> Loop</label>
      </section>
      <section class="controls">
        <label>Speed <output id="speedOut">100%</output><input id="speed" type="range" min="40" max="130" step="5" value="100"></label>
        <div class="transpose"><span>Key</span><button id="down" aria-label="Transpose down">−</button><output id="keyOut"></output><button id="up" aria-label="Transpose up">+</button></div>
      </section>
      ${isSong ? `<section class="info">
        <div class="loopline"><b>${entry.lyrics ? 'The chords' : 'The loop'}</b> ${esc(entry.chords.split(' ').map(M.pretty).join(' → '))}</div>
        ${entry.lyrics ? `<div class="card"><h3>Words</h3>${entry.lyrics.map(([tw, en]) => `<p><b>${esc(tw)}</b><br><i>${esc(en)}</i></p>`).join('')}</div>` : ''}
        ${entry.family ? `<div class="card"><h3>Song family</h3><p>${esc(entry.family)}</p></div>` : ''}
        ${entry.rhythm ? `<div class="card"><h3>Rhythm (from the book)</h3><p>${entry.rhythm}</p></div>` : ''}
        ${entry.fact ? `<div class="card"><h3>Did you know?</h3><p>${entry.fact}</p></div>` : ''}
        <a class="btn outline" href="${yt}" target="_blank" rel="noopener">▶ ${entry.lyrics ? 'Hear it sung (YouTube search)' : 'Hear the original recording (YouTube)'}</a>
        <p class="small-note">${entry.lyrics ? 'The player plays the book’s version in C. Use Key − / + to move it to your church’s key.' : 'The player uses the book’s simplified piano version so you can hear exactly what to play. The original recording opens on YouTube.'}</p>
      </section>` : ''}
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
      const [lo, hi] = rangeOf(compiled.tracks);
      $('#kb').innerHTML = keyboardSVG(lo, hi);
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

    function drawTracks() {
      $('#tracks').innerHTML = compiled.tracks.map((t, k) => `<button class="${k === trackIdx ? 'on' : ''}" data-k="${k}">${esc(t.name)}</button>`).join('');
      $('#keyOut').textContent = compiled.spec.key ? M.pretty(compiled.spec.key) : (semis ? `${semis > 0 ? '+' : ''}${semis}` : 'C');
    }

    function setLit(on) {
      lit.forEach((m) => { if (!on.has(m)) keys.get(m) && keys.get(m).classList.remove('rh', 'lh'); });
      on.forEach((val, m) => { const k = keys.get(m); if (k) { k.classList.remove('rh', 'lh'); k.classList.add(val); } });
      lit = new Set(on.keys());
    }

    function frame(beat) {
      const t = compiled.tracks[trackIdx];
      if (beat < 0) {
        setLit(new Map());
        bar.style.width = '0%';
        playBtn.textContent = '▶ Play';
        playBtn.classList.remove('stop');
        nowLabel.textContent = 'Press play';
        nowSub.textContent = t.desc;
        document.querySelectorAll('.chip.on').forEach((c) => c.classList.remove('on'));
        lastMark = null;
        return;
      }
      const on = new Map();
      t.events.forEach((e) => {
        if ((e.i === 'p' || e.i === 'l') && beat >= e.b && beat < e.b + Math.max(e.d, 0.18)) e.n.forEach((m) => on.set(m, e.i === 'l' || m < 60 ? 'lh' : 'rh'));
      });
      setLit(on);
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
      drawKeyboard(); drawChips(); drawTracks();
      frame(-1);
      if (wasPlaying) play();
    }

    drawKeyboard(); drawChips(); drawTracks();

    playBtn.addEventListener('click', () => { if (Player.playing) { Player.stop(); } else play(); });
    $('#tracks').addEventListener('click', (ev) => {
      const b = ev.target.closest('button');
      if (!b) return;
      trackIdx = Number(b.dataset.k);
      drawTracks(); drawChips();
      frame(-1);
      play();
    });
    $('#loop').addEventListener('change', (ev) => { Player.loop = ev.target.checked; });
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

  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
