/** Chrono Step — Web Audio による SE / BGM */

const STORAGE_KEY = 'chrono-step-vol';

function clamp01(n) {
  return Math.max(0, Math.min(1, Number(n) || 0));
}

function loadVol() {
  try {
    const v = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return {
      master: clamp01(v.master ?? 0.7),
      bgm: clamp01(v.bgm ?? 0.32),
      se: clamp01(v.se ?? 0.8),
      muted: !!v.muted,
    };
  } catch {
    return { master: 0.7, bgm: 0.32, se: 0.8, muted: false };
  }
}

export function createAudio() {
  let ctx = null;
  let masterGain = null;
  let bgmGain = null;
  let seGain = null;
  let bgmTimer = null;
  let bgmStep = 0;
  /** @type {'normal' | 'sudden'} */
  let bgmMode = 'normal';
  const vol = loadVol();

  function ensure() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    masterGain = ctx.createGain();
    bgmGain = ctx.createGain();
    seGain = ctx.createGain();
    bgmGain.connect(masterGain);
    seGain.connect(masterGain);
    masterGain.connect(ctx.destination);
    applyVol();
    return ctx;
  }

  function applyVol() {
    if (!masterGain) return;
    masterGain.gain.value = vol.muted ? 0 : vol.master;
    bgmGain.gain.value = vol.bgm;
    seGain.gain.value = vol.se;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(vol));
    } catch { /* ignore */ }
  }

  function resume() {
    const c = ensure();
    if (c?.state === 'suspended') c.resume();
  }

  function tone(freq, dur, type = 'sine', gain = 0.12, when = 0, dest = null) {
    const c = ensure();
    if (!c) return;
    const t0 = c.currentTime + when;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + Math.max(dur, 0.03));
    osc.connect(g);
    g.connect(dest || seGain);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  function noiseBurst(dur = 0.08, gain = 0.08) {
    const c = ensure();
    if (!c) return;
    const n = Math.floor(c.sampleRate * dur);
    const buf = c.createBuffer(1, n, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const src = c.createBufferSource();
    const g = c.createGain();
    const f = c.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 1600;
    src.buffer = buf;
    g.gain.value = gain;
    src.connect(f);
    f.connect(g);
    g.connect(seGain);
    src.start();
  }

  const SFX = {
    click() { tone(640, 0.05, 'triangle', 0.05); },
    dice() {
      noiseBurst(0.05, 0.09);
      tone(400, 0.05, 'square', 0.04, 0.02);
      tone(520, 0.05, 'square', 0.04, 0.07);
      tone(660, 0.08, 'square', 0.05, 0.12);
    },
    pickDie(face = 3) {
      tone(280 + face * 36, 0.1, 'triangle', 0.09);
      tone(420 + face * 28, 0.14, 'sine', 0.06, 0.04);
    },
    step() {
      tone(210, 0.045, 'triangle', 0.045);
      noiseBurst(0.025, 0.035);
    },
    place() {
      tone(360, 0.07, 'triangle', 0.07);
      tone(540, 0.12, 'sine', 0.06, 0.05);
    },
    drain() {
      tone(220, 0.16, 'sawtooth', 0.06);
      tone(160, 0.2, 'triangle', 0.05, 0.08);
      tone(480, 0.14, 'sine', 0.05, 0.12);
    },
    boost() {
      tone(392, 0.08, 'triangle', 0.07);
      tone(523, 0.1, 'triangle', 0.07, 0.07);
      tone(659, 0.14, 'sine', 0.08, 0.14);
    },
    reverse() {
      tone(520, 0.1, 'sine', 0.06);
      tone(390, 0.12, 'sine', 0.06, 0.08);
      tone(300, 0.16, 'triangle', 0.05, 0.16);
    },
    lock() {
      noiseBurst(0.06, 0.07);
      tone(180, 0.14, 'square', 0.07);
      tone(140, 0.18, 'square', 0.05, 0.08);
    },
    stomp() {
      noiseBurst(0.07, 0.08);
      tone(160, 0.12, 'sawtooth', 0.07);
      tone(240, 0.1, 'triangle', 0.05, 0.06);
    },
    fork() {
      tone(440, 0.07, 'sine', 0.06);
      tone(554, 0.09, 'sine', 0.06, 0.07);
    },
    eliminate() {
      tone(220, 0.18, 'sawtooth', 0.07);
      tone(165, 0.22, 'triangle', 0.06, 0.1);
      tone(110, 0.35, 'sine', 0.05, 0.22);
    },
    win() {
      [392, 523, 659, 784, 1046].forEach((f, i) => tone(f, 0.22, 'triangle', 0.09, i * 0.1));
    },
    round() {
      tone(330, 0.08, 'triangle', 0.05);
      tone(440, 0.1, 'sine', 0.05, 0.08);
    },
    yourTurn() {
      tone(392, 0.08, 'square', 0.06);
      tone(523, 0.1, 'triangle', 0.07, 0.08);
      tone(659, 0.14, 'sine', 0.08, 0.16);
    },
    sudden() {
      tone(520, 0.1, 'square', 0.07);
      tone(390, 0.12, 'square', 0.06, 0.1);
      tone(300, 0.16, 'sawtooth', 0.05, 0.2);
    },
  };

  // 落ち着いた時計回りフレーズ
  const BGM_NOTES = [
    196, 220, 247, 262, 294, 262, 247, 220,
    196, 247, 294, 330, 392, 330, 294, 247,
    220, 247, 262, 294, 330, 294, 262, 247,
    220, 0, 247, 262, 294, 0, 262, 220,
    196, 220, 247, 294, 330, 294, 247, 220,
    196, 247, 262, 294, 330, 392, 330, 294,
    262, 0, 247, 0, 220, 247, 262, 294,
    330, 294, 262, 247, 220, 196, 175, 0,
  ];
  const BGM_SUDDEN = [
    220, 208, 196, 185, 196, 208, 220, 0,
    233, 220, 208, 196, 208, 220, 233, 247,
    262, 247, 233, 220, 208, 196, 185, 175,
    185, 196, 208, 220, 233, 247, 262, 0,
  ];
  const BGM_STEP_MS = 520;
  const BGM_SUDDEN_MS = 280;

  function tickBgm() {
    if (!ctx || vol.muted) return;
    const sudden = bgmMode === 'sudden';
    const notes = sudden ? BGM_SUDDEN : BGM_NOTES;
    const note = notes[bgmStep % notes.length];
    bgmStep += 1;
    if (!note) return;
    if (sudden) {
      const pulse = 0.04 + (bgmStep % 4 === 0 ? 0.02 : 0);
      tone(note, 0.2, 'triangle', pulse * 0.5, 0, bgmGain);
      tone(note * 1.5, 0.16, 'sine', pulse * 0.25, 0.02, bgmGain);
      return;
    }
    const soft = 0.034 + (bgmStep % 8 === 0 ? 0.01 : 0);
    tone(note, 0.4, 'sine', soft, 0, bgmGain);
    tone(note * 1.5, 0.32, 'triangle', soft * 0.4, 0.03, bgmGain);
    if (bgmStep % 4 === 0) tone(note / 2, 0.5, 'sine', 0.016, 0, bgmGain);
  }

  function restartBgmTimer() {
    if (bgmTimer) clearInterval(bgmTimer);
    const ms = bgmMode === 'sudden' ? BGM_SUDDEN_MS : BGM_STEP_MS;
    tickBgm();
    bgmTimer = setInterval(tickBgm, ms);
  }

  function startBgm() {
    resume();
    if (bgmTimer) return;
    bgmStep = 0;
    restartBgmTimer();
  }

  function stopBgm() {
    if (bgmTimer) clearInterval(bgmTimer);
    bgmTimer = null;
  }

  function setBgmMode(mode) {
    const next = mode === 'sudden' ? 'sudden' : 'normal';
    if (next === bgmMode) return bgmMode;
    bgmMode = next;
    bgmStep = 0;
    if (bgmTimer) restartBgmTimer();
    if (next === 'sudden') SFX.sudden();
    return bgmMode;
  }

  return {
    resume,
    startBgm,
    stopBgm,
    setBgmMode,
    getBgmMode() { return bgmMode; },
    sfx: SFX,
    getVolume() { return { ...vol }; },
    setMaster(v) { vol.master = clamp01(v); applyVol(); },
    setBgm(v) { vol.bgm = clamp01(v); applyVol(); },
    setSe(v) { vol.se = clamp01(v); applyVol(); },
    setMuted(m) { vol.muted = !!m; applyVol(); },
    toggleMute() { vol.muted = !vol.muted; applyVol(); return vol.muted; },
  };
}
