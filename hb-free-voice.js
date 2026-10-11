/* Dr. Kaya's selected free voice. No credentials, remote voice service or voice fallback. */
(function (global) {
  'use strict';
  var base = new URL('./free-voice/', document.currentScript.src), worker = null, generation = 0;
  var current = null, loadingTimer = 0, state = 'idle', detail = '';
  var supported = typeof Worker !== 'undefined' && typeof WebAssembly !== 'undefined';
  var onState = function (next, why) {
    state = next; detail = why || '';
    global.dispatchEvent(new CustomEvent('hb-voice-state', { detail: { state: state, detail: detail } }));
  };
  function stopWorker() {
    ++generation;
    clearTimeout(loadingTimer); loadingTimer = 0;
    if (worker) worker.terminate();
    worker = null;
  }
  function finish(result) {
    if (!current) return;
    var request = current; current = null;
    clearTimeout(request.timer);
    request.done(Object.assign({ id: request.id }, result));
  }
  function fail(reason, message) {
    stopWorker(); onState('error', message);
    finish({ reason: reason, detail: message });
  }
  function beginSpeech() {
    if (!current || !worker || state !== 'ready' || current.started) return;
    current.started = true;
    clearTimeout(current.timer);
    // Long answers can take time on lower-powered devices, but never hold forever.
    var synthesisBudget = Math.min(150000, Math.max(45000, current.text.length * 250));
    current.timer = setTimeout(function () { fail('timeout', 'The voice took too long on this device.'); }, synthesisBudget);
    worker.postMessage({ type: 'speak', id: current.id, text: current.text });
  }
  function warmup() {
    if (!supported) { onState('unsupported', 'This browser cannot run the selected voice.'); return; }
    if (worker) return;
    onState('loading', '');
    var epoch = ++generation;
    try {
      worker = new Worker(new URL('voice-worker.mjs', base), { type: 'module', name: 'Dr Kaya voice' });
      worker.onerror = function () { if (epoch === generation) fail('down', 'The selected voice could not load.'); };
      worker.onmessage = function (event) {
        if (epoch !== generation) return;
        var data = event.data;
        if (data.type === 'state') {
          if (data.state === 'error') { fail('down', data.detail || 'The selected voice could not load.'); return; }
          onState(data.state, data.detail);
          if (state === 'ready') { clearTimeout(loadingTimer); loadingTimer = 0; beginSpeech(); }
        } else if (current && data.id === current.id) {
          if (data.type === 'audio') finish(data);
          else if (data.type === 'error') finish({ reason: data.reason || 'down', detail: data.detail || '' });
        }
      };
      loadingTimer = setTimeout(function () { fail('loading', 'Voice download did not finish. Try again when the connection is ready.'); }, 180000);
      worker.postMessage({ type: 'warmup' });
    } catch (e) { fail('unsupported', 'This browser could not start the selected voice.'); }
  }
  global.HBFreeVoice = {
    get state() { return state; }, get detail() { return detail; }, supported: supported,
    warmup: warmup,
    speak: function (id, text, done) {
      if (current) this.cancel(current.id);
      current = { id: id, text: text, done: done, started: false, timer: 0 };
      if (!supported) { finish({ reason: 'unsupported', detail: 'This browser cannot run the selected voice.' }); return; }
      // A question waits at most 20 s for preparation. The background download
      // may continue, so the next question can use it without starting over.
      current.timer = setTimeout(function () { finish({ reason: 'loading', detail: 'The selected voice is still downloading. Please try again shortly.' }); }, 20000);
      warmup(); beginSpeech();
    },
    cancel: function (id) {
      if (!current || current.id !== id) return;
      var running = current.started;
      finish({ reason: 'cancelled', detail: '' });
      // Inference cannot be interrupted inside ONNX; terminate that worker so an
      // abandoned answer does not consume CPU or delay the next learner turn.
      if (running) { stopWorker(); onState('idle', ''); }
    }
  };
  // Download while the lesson opens and its pre-recorded introduction plays.
  warmup();
})(window);
