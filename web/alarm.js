// Sesli alarm. Web Audio ile uretilir, dosya gerekmez; cevrimdisi da calisir.
//
// iOS Safari ses baglamini yalnizca bir kullanici dokunusundan sonra acar.
// unlockAudio() bu yuzden dugme tiklamalarinda cagrilir; alarm ani geldiginde
// baglam zaten acik olur.

let context = null;
let loop = null;

export function unlockAudio() {
  try {
    const AudioContextImpl = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextImpl) return false;
    context ??= new AudioContextImpl();
    if (context.state === 'suspended') context.resume();
    return true;
  } catch { return false; }
}

/** Tek bip. frequency Hz, durationMs sure, gain 0..1. */
export function beep({ frequency = 880, durationMs = 180, gain = 0.5 } = {}) {
  if (!context) unlockAudio();
  if (!context) return;
  try {
    const oscillator = context.createOscillator();
    const volume = context.createGain();
    oscillator.type = 'square';
    oscillator.frequency.value = frequency;
    volume.gain.value = gain;
    oscillator.connect(volume).connect(context.destination);
    const now = context.currentTime;
    oscillator.start(now);
    // Kesik kesik bitis: tik sesi olusmasin.
    volume.gain.setValueAtTime(gain, now + durationMs / 1000 - 0.02);
    volume.gain.linearRampToValueAtTime(0.0001, now + durationMs / 1000);
    oscillator.stop(now + durationMs / 1000);
  } catch { /* ses yoksa titresim yine calisir */ }
}

/**
 * Surekli alarm: 'anchor' capa taramasi (hizli, tiz), 'gps' konum kaybi (yavas,
 * pes), 'alert' genel uyari (tek cift bip). stopAlarm() ile durur.
 */
export function startAlarm(kind = 'anchor') {
  stopAlarm();
  const patterns = {
    anchor: { frequency: 1050, on: 160, off: 140, count: 3, pause: 700 },
    gps: { frequency: 520, on: 350, off: 250, count: 2, pause: 1800 },
  };
  const p = patterns[kind] ?? patterns.anchor;
  let cancelled = false;
  const run = async () => {
    while (!cancelled) {
      for (let i = 0; i < p.count && !cancelled; i++) {
        beep({ frequency: p.frequency, durationMs: p.on, gain: 0.6 });
        if (navigator.vibrate) navigator.vibrate(p.on);
        await new Promise(resolve => setTimeout(resolve, p.on + p.off));
      }
      await new Promise(resolve => setTimeout(resolve, p.pause));
    }
  };
  loop = { cancel: () => { cancelled = true; } };
  run();
}

export function stopAlarm() {
  if (loop) { loop.cancel(); loop = null; }
}

export function isAlarming() { return loop !== null; }

/** Tek seferlik dikkat sesi: rota noktasina varis, sapma vb. */
export function chime() {
  beep({ frequency: 740, durationMs: 120, gain: 0.4 });
  setTimeout(() => beep({ frequency: 988, durationMs: 160, gain: 0.4 }), 140);
}
