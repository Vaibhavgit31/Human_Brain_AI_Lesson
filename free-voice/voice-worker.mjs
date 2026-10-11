import { KokoroTTS, env } from './vendor/kokoro-1.2.1.web.mjs';
import { KOKORO_PROFILE, KOKORO_PROFILE_ID, kokoroSpeechText, splitKokoroText, joinKokoroAudio, prepareKokoroAudio } from './kokoro-profile.mjs';

// This module runs only in a dedicated Worker. One WASM thread works on speech;
// Unity's rendering/audio thread never performs ONNX inference.
env.configureLocal(new URL('./', import.meta.url));
let engine, pronunciation, loading;
const state = (value, detail = '') => postMessage({ type: 'state', state: value, detail, profile: KOKORO_PROFILE_ID });
async function prepare() {
  if (engine) return;
  if (loading) return loading;
  state('loading');
  loading = (async () => {
    const response = await fetch(new URL('./pronunciation.json', import.meta.url));
    if (!response.ok) throw Error('The pronunciation file could not load.');
    pronunciation = (await response.json()).entries;
    engine = await KokoroTTS.from_pretrained(KOKORO_PROFILE.model, {
      dtype: KOKORO_PROFILE.dtype, device: 'wasm', progress_callback: p => {
        if (p.status === 'progress' && p.file?.endsWith('.onnx')) state('loading', Math.round(p.progress || 0) + '%');
      }
    });
    state('ready');
  })();
  return loading;
}
let active = false;
self.onmessage = async ({ data }) => {
  if (data.type === 'warmup') {
    try { await prepare(); } catch (e) { state('error', String(e.message || e)); }
    return;
  }
  if (data.type !== 'speak') return;
  const id = data.id;
  if (active) { postMessage({ type: 'error', id, reason: 'busy', detail: 'Voice is already preparing an answer.' }); return; }
  active = true;
  const start = performance.now();
  try {
    await prepare();
    const text = kokoroSpeechText(String(data.text || '').slice(0, 600), pronunciation);
    if (!text) throw Error('There are no words to speak.');
    const chunks = splitKokoroText(text), arrays = [];
    for (const chunk of chunks) {
      const audio = await engine.generate(chunk, { voice: KOKORO_PROFILE.voice, speed: KOKORO_PROFILE.speed });
      if (audio.sampling_rate !== 24000 || !audio.audio?.length) throw Error('The voice returned invalid audio.');
      arrays.push(audio.audio);
    }
    const result = prepareKokoroAudio(joinKokoroAudio(arrays), 24000);
    const envelope = Uint8Array.from(result.envelope, x => Math.round(Math.max(0, Math.min(1, x)) * 255));
    postMessage({ type: 'audio', id, wav: result.wav.buffer, envelope: envelope.buffer, rate: result.rate,
      profile: KOKORO_PROFILE_ID, model: 'kokoro-82m', voice: 'am_puck', source: 'kokoro',
      pieces: chunks.length, providerMs: Math.round(performance.now() - start) }, [result.wav.buffer, envelope.buffer]);
  } catch (e) {
    postMessage({ type: 'error', id, reason: 'down', detail: String(e.message || e) });
  } finally { active = false; }
};
