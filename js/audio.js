/*
 * THoldem audio — every sound is synthesized live with the Web Audio API, so
 * the app ships with no audio files. A custom clip can be uploaded for any
 * cue (stored in IndexedDB).
 */
(function (root) {
  'use strict';

  const SOUNDS = {
    primetime: 'Prime Time Fanfare (90s sports TV)',
    shuffleup: 'Shuffle Up Stinger',
    bell: 'Casino Bell',
    airhorn: 'Air Horn',
    chime: 'Ding-Dong Chime',
    beeps: 'Countdown Beeps',
    lounge: 'Lounge Break',
    custom: 'Custom upload…',
    none: 'Silent',
  };

  let ctx = null;
  let master = null;
  let noiseBuf = null;
  let volume = 0.8;
  const customBuffers = {}; // cue -> AudioBuffer

  function ensure() {
    if (!ctx) {
      const AC = root.AudioContext || root.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = volume;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 4;
      master.connect(comp).connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function setVolume(v) {
    volume = Math.max(0, Math.min(1, Number(v)));
    if (master) master.gain.setTargetAtTime(volume, ctx.currentTime, 0.02);
  }

  function noise() {
    if (noiseBuf) return noiseBuf;
    const len = ctx.sampleRate * 2;
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return noiseBuf;
  }

  const hz = (midi) => 440 * Math.pow(2, (midi - 69) / 12);

  // --- Instruments -----------------------------------------------------------

  /** Big brass section: detuned saws through an opening low-pass filter. */
  function brass(t, notes, dur, gain = 0.18, bright = 3200) {
    const out = ctx.createGain();
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.Q.value = 2;
    filt.frequency.setValueAtTime(500, t);
    filt.frequency.exponentialRampToValueAtTime(bright, t + 0.06);
    filt.frequency.exponentialRampToValueAtTime(bright * 0.55, t + dur);
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(gain, t + 0.025);
    out.gain.setTargetAtTime(gain * 0.7, t + 0.08, 0.1);
    out.gain.setTargetAtTime(0.0001, t + dur, 0.09);
    filt.connect(out).connect(master);
    notes.forEach((n) => {
      [-7, 0, 7].forEach((det) => {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = hz(n);
        o.detune.value = det;
        // Brass "fall-in": a slight pitch scoop at the start.
        o.detune.setValueAtTime(det - 40, t);
        o.detune.linearRampToValueAtTime(det, t + 0.05);
        o.connect(filt);
        o.start(t);
        o.stop(t + dur + 0.6);
      });
    });
  }

  function timpani(t, midi, gain = 0.9, len = 1.2) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(hz(midi) * 1.5, t);
    o.frequency.exponentialRampToValueAtTime(hz(midi), t + 0.08);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + len + 0.1);
    // Mallet thump.
    const n = ctx.createBufferSource();
    n.buffer = noise();
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 900;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(gain * 0.5, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    n.connect(f).connect(ng).connect(master);
    n.start(t);
    n.stop(t + 0.2);
  }

  function cymbal(t, gain = 0.35, len = 2.2) {
    const n = ctx.createBufferSource();
    n.buffer = noise();
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 5000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    n.connect(f).connect(g).connect(master);
    n.start(t);
    n.stop(t + len + 0.1);
  }

  function snare(t, gain = 0.25) {
    const n = ctx.createBufferSource();
    n.buffer = noise();
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 2200;
    f.Q.value = 0.7;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    n.connect(f).connect(g).connect(master);
    n.start(t);
    n.stop(t + 0.12);
  }

  function snareRoll(t, len, from = 0.04, to = 0.3) {
    const step = 0.045;
    const count = Math.floor(len / step);
    for (let i = 0; i < count; i++) snare(t + i * step, from + ((to - from) * i) / count);
  }

  function bellTone(t, freq, gain = 0.3, len = 2.5) {
    [1, 2.76, 5.4, 8.93].forEach((ratio, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = freq * ratio;
      g.gain.setValueAtTime(gain / (i + 1), t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + len / (i + 1));
      o.connect(g).connect(master);
      o.start(t);
      o.stop(t + len);
    });
  }

  function tone(t, freq, len, type = 'sine', gain = 0.25) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + len + 0.05);
  }

  // --- Cues --------------------------------------------------------------------

  const PLAYERS = {
    /** A punchy, original big-network sports-broadcast style brass stinger. */
    primetime(t) {
      snareRoll(t, 0.7, 0.03, 0.32);
      // Pickup: three stabs climbing into the big hit.
      const G = 55; // G3
      brass(t + 0.72, [G, G + 4, G + 7], 0.14, 0.16);
      timpani(t + 0.72, 31, 0.6, 0.4);
      brass(t + 0.9, [G, G + 4, G + 7], 0.14, 0.16);
      brass(t + 1.08, [G + 2, G + 5, G + 9], 0.2, 0.18);
      timpani(t + 1.08, 33, 0.6, 0.4);
      // The big hit — C major with the octave on top.
      const C = 60;
      brass(t + 1.35, [C - 12, C, C + 4, C + 7, C + 12], 0.55, 0.22, 4200);
      timpani(t + 1.35, 36, 1, 1.4);
      cymbal(t + 1.35, 0.4, 2.4);
      // Answer phrase: Bb - F - C for the triumphant close.
      brass(t + 1.95, [C - 2, C + 2, C + 5, C + 10], 0.18, 0.18);
      brass(t + 2.17, [C - 7, C + 0, C + 5, C + 9], 0.18, 0.18);
      snare(t + 2.17, 0.3);
      brass(t + 2.4, [C - 12, C, C + 4, C + 7, C + 12, C + 16], 1.3, 0.24, 4800);
      timpani(t + 2.4, 36, 1, 1.8);
      cymbal(t + 2.4, 0.45, 3);
      for (let i = 0; i < 10; i++) timpani(t + 2.55 + i * 0.07, 36, 0.12 + i * 0.03, 0.2);
      timpani(t + 3.3, 24, 1, 2);
      return 5.5;
    },
    shuffleup(t) {
      const C = 62;
      brass(t, [C, C + 7], 0.12, 0.16);
      brass(t + 0.15, [C + 3, C + 10], 0.12, 0.16);
      brass(t + 0.3, [C + 5, C + 12], 0.12, 0.16);
      brass(t + 0.48, [C - 12, C, C + 7, C + 12, C + 15], 0.9, 0.22, 4200);
      timpani(t + 0.48, 38, 1, 1.4);
      cymbal(t + 0.48, 0.35, 2);
      return 2.5;
    },
    bell(t) {
      bellTone(t, 880, 0.32);
      bellTone(t + 0.35, 880, 0.32);
      bellTone(t + 0.7, 880, 0.36, 3);
      return 3.5;
    },
    airhorn(t) {
      [0, 0.3, 0.6].forEach((dt, i) => {
        const len = i === 2 ? 0.9 : 0.22;
        [466, 587, 698].forEach((f) => {
          const o = ctx.createOscillator();
          const g = ctx.createGain();
          const lfo = ctx.createOscillator();
          const lg = ctx.createGain();
          o.type = 'sawtooth';
          o.frequency.value = f;
          lfo.frequency.value = 6;
          lg.gain.value = 6;
          lfo.connect(lg).connect(o.frequency);
          g.gain.setValueAtTime(0.0001, t + dt);
          g.gain.exponentialRampToValueAtTime(0.09, t + dt + 0.02);
          g.gain.setValueAtTime(0.09, t + dt + len);
          g.gain.exponentialRampToValueAtTime(0.0001, t + dt + len + 0.05);
          o.connect(g).connect(master);
          o.start(t + dt);
          lfo.start(t + dt);
          o.stop(t + dt + len + 0.1);
          lfo.stop(t + dt + len + 0.1);
        });
      });
      return 1.8;
    },
    chime(t) {
      tone(t, hz(76), 1.2, 'sine', 0.3);
      tone(t, hz(88), 0.6, 'sine', 0.06);
      tone(t + 0.45, hz(72), 1.6, 'sine', 0.3);
      tone(t + 0.45, hz(84), 0.8, 'sine', 0.06);
      return 2.2;
    },
    beeps(t) {
      tone(t, 880, 0.15, 'square', 0.12);
      tone(t + 0.5, 880, 0.15, 'square', 0.12);
      tone(t + 1.0, 880, 0.15, 'square', 0.12);
      tone(t + 1.5, 1320, 0.5, 'square', 0.14);
      return 2.1;
    },
    lounge(t) {
      [67, 64, 60, 55].forEach((n, i) => {
        tone(t + i * 0.22, hz(n), 1.4, 'triangle', 0.18);
        tone(t + i * 0.22, hz(n + 12), 0.8, 'sine', 0.05);
      });
      tone(t + 0.9, hz(48), 2, 'sine', 0.2);
      return 3;
    },
    none() {
      return 0;
    },
  };

  function play(name, cue) {
    if (!ensure()) return 0;
    const t = ctx.currentTime + 0.05;
    if (name === 'custom') {
      const buf = customBuffers[cue];
      if (!buf) return PLAYERS.chime(t);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(master);
      src.start(t);
      return buf.duration;
    }
    const fn = PLAYERS[name] || PLAYERS.chime;
    return fn(t);
  }

  // --- Custom clips (IndexedDB) -------------------------------------------------

  function db() {
    return new Promise((resolve, reject) => {
      if (!root.indexedDB) return reject(new Error('IndexedDB unavailable'));
      const req = root.indexedDB.open('tholdem-audio', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('clips');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function storeClip(cue, arrayBuffer, name) {
    ensure();
    const buf = await ctx.decodeAudioData(arrayBuffer.slice(0));
    customBuffers[cue] = buf;
    try {
      const d = await db();
      await new Promise((res, rej) => {
        const tx = d.transaction('clips', 'readwrite');
        tx.objectStore('clips').put({ data: arrayBuffer, name }, cue);
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
      });
    } catch (e) {
      /* The clip still works for this session. */
    }
    return buf.duration;
  }

  async function loadClips() {
    const names = {};
    try {
      const d = await db();
      const entries = await new Promise((res, rej) => {
        const out = [];
        const tx = d.transaction('clips', 'readonly');
        const req = tx.objectStore('clips').openCursor();
        req.onsuccess = () => {
          const cur = req.result;
          if (cur) { out.push([cur.key, cur.value]); cur.continue(); } else res(out);
        };
        req.onerror = () => rej(req.error);
      });
      for (const [cue, v] of entries) {
        names[cue] = v.name;
        try {
          if (ensure()) customBuffers[cue] = await ctx.decodeAudioData(v.data.slice(0));
        } catch (e) { /* ignore a broken clip */ }
      }
    } catch (e) { /* no stored clips */ }
    return names;
  }

  // --- Voice ------------------------------------------------------------------

  function voices() {
    return root.speechSynthesis ? root.speechSynthesis.getVoices() : [];
  }

  function say(text, voiceName, delaySec) {
    if (!root.speechSynthesis || !text) return;
    const speak = () => {
      const u = new SpeechSynthesisUtterance(text);
      const v = voices().find((x) => x.name === voiceName) || voices().find((x) => /en[-_]US/i.test(x.lang)) || null;
      if (v) u.voice = v;
      u.rate = 0.98;
      u.pitch = 0.9;
      u.volume = Math.max(0.1, volume);
      root.speechSynthesis.cancel();
      root.speechSynthesis.speak(u);
    };
    if (delaySec > 0) setTimeout(speak, delaySec * 1000);
    else speak();
  }

  root.PokerAudio = { SOUNDS, ensure, play, setVolume, storeClip, loadClips, say, voices };
})(typeof self !== 'undefined' ? self : this);
