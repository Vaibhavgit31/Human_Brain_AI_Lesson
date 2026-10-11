/** One free voice, shared by offline narration, Node replies and browser replies. No Node-only imports. */
export const KOKORO_PROFILE = Object.freeze({
  provider: 'kokoro', model: 'onnx-community/Kokoro-82M-v1.0-ONNX', dtype: 'q8', voice: 'am_puck',
  speed: 0.95, libraryVersion: '1.2.1', inputRate: 24000, outputRate: 26939, maxChunkChars: 240, chunkGapSeconds: 0.16,
  processing: 'pcm16-rms0.12-peak0.92-trim40-90ms-fade6ms-v1', textProcessing: 'speech-text-pronunciation-v1',
});
// SHA-256(JSON.stringify(KOKORO_PROFILE)), first 16 hex characters; asserted by tests.
export const KOKORO_PROFILE_ID = '9a0dbacaa10c67be';

export async function sha256Hex(value) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes)), x => x.toString(16).padStart(2, '0')).join('');
}

function pronunciationEntries(entries = []) {
  return entries.filter(e => e && e.enabled !== false && typeof e.term === 'string' && typeof e.say === 'string' && e.term.trim() && e.say.trim())
    .map(e => ({ term: e.term.trim(), say: e.say.trim(), enabled: true }));
}

export const kokoroPronunciationHash = entries => sha256Hex(JSON.stringify(pronunciationEntries(entries)));
export const kokoroLineHash = (text, pronunciationHash) => sha256Hex(JSON.stringify({ text, profileId: KOKORO_PROFILE_ID, pronunciationHash }));

export function applyKokoroPronunciation(text, entries = []) {
  const ordered = pronunciationEntries(entries).sort((a, b) => b.term.length - a.term.length);
  if (!ordered.length) return String(text ?? '');
  const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lookup = new Map(ordered.map(e => [e.term.toLowerCase(), e.say]));
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(${ordered.map(e => escape(e.term)).join('|')})(?![\\p{L}\\p{N}])`, 'giu');
  return String(text ?? '').replace(pattern, word => lookup.get(word.toLowerCase()) ?? word);
}

export function kokoroSpeechText(text, entries = []) {
  return applyKokoroPronunciation(text, entries).replace(/^[\s….]+/, '').replace(/…/g, '...')
    .replace(/\bDr\.(?=\s)/g, 'Doctor').replace(/\s+/g, ' ').trim();
}

export function splitKokoroText(text, max = KOKORO_PROFILE.maxChunkChars) {
  if (!Number.isInteger(max) || max < 1) throw new Error('Invalid Kokoro chunk size.');
  const pieces = [];
  let rest = String(text).trim();
  while (rest.length > max) {
    const head = rest.slice(0, max);
    let cut = Math.max(head.lastIndexOf('. '), head.lastIndexOf('? '), head.lastIndexOf('! ')) + 1;
    if (cut < max * 0.3) cut = Math.max(head.lastIndexOf(', '), head.lastIndexOf('; ')) + 1;
    if (cut < max * 0.3) cut = head.lastIndexOf(' ');
    if (cut <= 0) cut = max;
    pieces.push(rest.slice(0, cut).trim()); rest = rest.slice(cut).trim();
  }
  if (rest) pieces.push(rest);
  return pieces;
}

export function joinKokoroAudio(pieces) {
  if (!pieces.length || pieces.some(p => !(p instanceof Float32Array))) throw new Error('Missing Kokoro audio pieces.');
  if (pieces.length === 1) return pieces[0];
  const gap = Math.round(KOKORO_PROFILE.inputRate * KOKORO_PROFILE.chunkGapSeconds);
  const total = pieces.reduce((n, p) => n + p.length, 0) + gap * (pieces.length - 1);
  if (total > KOKORO_PROFILE.inputRate * 120) throw new Error('Kokoro audio exceeds 120 seconds.');
  const joined = new Float32Array(total);
  let offset = 0;
  for (const piece of pieces) { joined.set(piece, offset); offset += piece.length + gap; }
  return joined;
}

/** Normalize at the source rate; the selected +2-semitone delivery is encoded once in the WAV rate.
 * Consumers play this WAV at 1x. The envelope already follows the output rate, never the original 24 kHz clock.
 */
export function prepareKokoroAudio(audio, samplingRate = KOKORO_PROFILE.inputRate) {
  if (!(audio instanceof Float32Array) || samplingRate !== KOKORO_PROFILE.inputRate
    || audio.length < samplingRate / 10 || audio.length > samplingRate * 120)
    throw new Error('Expected 0.1–120 seconds of Kokoro mono 24 kHz Float32 audio.');
  let originalPeak = 0;
  for (const x of audio) { if (!Number.isFinite(x)) throw new Error('Non-finite Kokoro audio.'); originalPeak = Math.max(originalPeak, Math.abs(x)); }
  if (originalPeak < 24 / 32768) throw new Error('Kokoro returned silence.');
  const win = Math.round(samplingRate * 0.01);
  const loud = start => {
    let sum = 0;
    for (let i = start; i < Math.min(audio.length, start + win); i++) sum += audio[i] * audio[i];
    return Math.sqrt(sum / win) > 0.012;
  };
  let a = 0, b = audio.length;
  while (a + win < audio.length && !loud(a)) a += win;
  while (b - win > a && !loud(b - win)) b -= win;
  a = Math.max(0, a - Math.round(samplingRate * 0.04));
  b = Math.min(audio.length, b + Math.round(samplingRate * 0.09));
  let sum = 0, count = 0, peak = 1e-6;
  for (let i = a; i < b; i++) {
    const v = Math.abs(audio[i]); peak = Math.max(peak, v);
    if (v > 0.02) { sum += v * v; count++; }
  }
  const gain = Math.min(0.12 / Math.max(1e-4, Math.sqrt(sum / Math.max(1, count))), 0.92 / peak, 5);
  const frames = b - a, rate = KOKORO_PROFILE.outputRate, fade = Math.round(samplingRate * 0.006);
  if (frames < samplingRate / 10) throw new Error('Kokoro audio too short after trimming.');
  const wav = new Uint8Array(44 + frames * 2), view = new DataView(wav.buffer);
  const ascii = (at, s) => { for (let i = 0; i < s.length; i++) wav[at + i] = s.charCodeAt(i); };
  ascii(0, 'RIFF'); view.setUint32(4, wav.length - 8, true); ascii(8, 'WAVE'); ascii(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true);
  view.setUint16(34, 16, true); ascii(36, 'data'); view.setUint32(40, frames * 2, true);
  let outputPeak = 0, outputSum = 0;
  for (let i = 0; i < frames; i++) {
    const edge = Math.min(1, i / fade, (frames - 1 - i) / fade);
    const sample = Math.max(-32768, Math.min(32767, Math.round(audio[a + i] * gain * edge * 32767)));
    view.setInt16(44 + i * 2, sample, true);
    outputPeak = Math.max(outputPeak, Math.abs(sample / 32768)); outputSum += (sample / 32768) ** 2;
  }
  const window = Math.round(rate / 30), levels = [];
  let max = 1e-6;
  for (let s = 0; s < frames; s += window) {
    let power = 0, n = 0;
    for (let i = s; i < Math.min(frames, s + window); i++) { power += (view.getInt16(44 + i * 2, true) / 32768) ** 2; n++; }
    const level = Math.sqrt(power / Math.max(1, n)); levels.push(level); max = Math.max(max, level);
  }
  const envelope = levels.map((v, i) => {
    const x = (v + levels[Math.max(0, i - 1)] + levels[Math.min(levels.length - 1, i + 1)]) / 3 / max;
    return Math.round(Math.min(1, Math.max(0, (x - 0.08) / 0.7)) * 1000) / 1000;
  });
  return { wav, envelope, rate, duration: frames / rate, peak: outputPeak, rms: Math.sqrt(outputSum / frames) };
}
