/* Fast live replies. Recorded lesson clips keep their approved voice. */
(function () {
  'use strict';
  const synth = window.speechSynthesis;
  const supported = !!(synth && window.SpeechSynthesisUtterance);
  const profile = Object.freeze({ preferred: 'Microsoft Mark', pitch: 1.24, rate: 1.06 });
  let selected = null, current = null, state = supported ? 'loading' : 'unavailable';
  function score(v) {
    return (/Microsoft Mark/i.test(v.name) ? 1000 : /Microsoft/i.test(v.name) ? 200 : 0)
      + (v.localService ? 50 : 0) + (/^en[-_]IN$/i.test(v.lang) ? 20 : 0) + (v.default ? 5 : 0);
  }
  function refresh() {
    if (!supported) return;
    selected = synth.getVoices().filter(v => /^en(?:[-_]|$)/i.test(v.lang))
      .sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name))[0] || null;
    if (selected) state = 'ready';
  }
  function emit(r, data) { r.event(Object.assign({ id: r.id }, data)); }
  function finish(r, reason) {
    if (current !== r) return;
    current = null;
    clearInterval(r.timer);
    if (reason && synth) synth.cancel();
    emit(r, { kind: reason ? 'error' : 'end', reason: reason || '' });
  }
  function chunks(text) {
    const result = [];
    for (let at = 0; at < text.length;) {
      let end = Math.min(at + 160, text.length);
      if (end < text.length) {
        const section = text.slice(at, end), sentence = [...section.matchAll(/[.!?]\s/g)].pop();
        const cut = sentence && sentence.index >= 35 ? sentence.index + 2 : section.lastIndexOf(' ') + 1;
        if (cut > 0) end = at + cut;
      }
      result.push({ text: text.slice(at, end), at });
      at = end;
    }
    return result;
  }
  function next(r) {
    if (current !== r) return;
    if (r.index === r.parts.length) { finish(r, ''); return; }
    const part = r.parts[r.index++], u = new SpeechSynthesisUtterance(part.text);
    r.utterance = u; r.chunkTime = 0; r.chunkStarted = false;
    u.voice = r.voice; u.lang = r.voice.lang;
    u.pitch = profile.pitch; u.rate = profile.rate; u.volume = r.volume;
    const active = () => current === r && r.utterance === u;
    u.onstart = () => {
      if (!active()) return;
      r.chunkStarted = true;
      if (!r.started) {
        r.started = true;
        const ms = Math.round(performance.now() - r.begin);
        console.log('[BROWSER TTS] started in ' + ms + ' ms; ' + r.voice.name + '; pitch=' + u.pitch + '; rate=' + u.rate);
        emit(r, { kind: 'start', voice: r.voice.name, ms });
      }
      if (active()) emit(r, { kind: 'boundary', charIndex: part.at });
    };
    u.onboundary = e => { if (active()) emit(r, { kind: 'boundary', charIndex: part.at + (e.charIndex || 0) }); };
    u.onend = () => { if (active()) next(r); };
    u.onerror = e => { if (active()) finish(r, e.error || 'unavailable'); };
    try { synth.speak(u); } catch (_) { finish(r, 'unavailable'); }
  }
  window.HBLiveVoice = {
    supported, profile,
    get state() { return state; },
    get voiceName() { return selected ? selected.name : ''; },
    warmup: refresh,
    speak(id, text, volume, event) {
      if (current) finish(current, 'cancelled');
      refresh();
      const r = current = { id, event, volume: Math.max(0, Math.min(1, Number(volume) || 0)),
        voice: selected, begin: performance.now(), index: 0, elapsed: 0, chunkTime: 0, paused: false };
      if (!supported || !selected) { finish(r, 'unavailable'); return; }
      if (typeof text !== 'string' || !text.trim() || text.length > 650) { finish(r, 'invalid-text'); return; }
      if (!r.volume) { finish(r, 'muted'); return; }
      r.parts = chunks(text);
      r.lastTick = performance.now();
      r.timer = setInterval(() => {
        const now = performance.now(), delta = now - r.lastTick; r.lastTick = now;
        if (current !== r || r.paused) return;
        r.elapsed += delta; r.chunkTime += delta;
        if (r.elapsed > 120000 || r.chunkTime > (r.chunkStarted ? 30000 : 5000)) finish(r, 'timeout');
      }, 250);
      synth.cancel(); synth.resume(); next(r);
    },
    cancel(id) { if (current && (id === undefined || current.id === id)) finish(current, 'cancelled'); },
    pause(paused) {
      if (!current || current.paused === !!paused) return;
      current.paused = !!paused;
      current.lastTick = performance.now();
      if (paused) synth.pause(); else synth.resume();
    },
    setVolume(volume) {
      if (!current) return;
      current.volume = Math.max(0, Math.min(1, Number(volume) || 0));
      // Engines may ignore a mid-utterance volume change; cancellation guarantees immediate mute.
      if (!current.volume) finish(current, 'muted');
      else if (current.utterance) current.utterance.volume = current.volume;
    }
  };
  if (supported) {
    synth.addEventListener('voiceschanged', refresh);
    refresh();
    setTimeout(() => { if (!selected) state = 'unavailable'; }, 3000);
  }
  window.addEventListener('pagehide', () => window.HBLiveVoice.cancel());
}());
