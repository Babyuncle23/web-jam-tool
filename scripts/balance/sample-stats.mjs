/**
 * Fetch the TR-808 WAVs and report peak / RMS / onset offset per voice.
 * Onset = first sample above 10% of file peak; peakAt = index of max |sample|.
 */
const CDN = 'https://cdn.jsdelivr.net/gh/fluid-music/open-drums/tr-808/TR808WAV';
const URLS = {
  kick: `${CDN}/BD/BD0025.WAV`,
  snare: `${CDN}/SD/SD2575.WAV`,
  hat: `${CDN}/CH/CH.WAV`,
  openhat: `${CDN}/OH/OH75.WAV`,
  tom: `${CDN}/MT/MT25.WAV`,
  cowbell: `${CDN}/CB/CB.WAV`,
  clap: `${CDN}/CP/CP.WAV`,
};

function decodeWav(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (view.getUint32(0, false) !== 0x52494646) throw new Error('not RIFF');
  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= view.byteLength) {
    const id = view.getUint32(offset, false);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 0x666d7420) fmt = { audioFormat: view.getUint16(body, true), channels: view.getUint16(body + 2, true), sampleRate: view.getUint32(body + 4, true), bits: view.getUint16(body + 14, true) };
    if (id === 0x64617461) data = { offset: body, size };
    offset = body + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('bad wav');
  const frames = data.size / (fmt.channels * (fmt.bits / 8));
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    let sum = 0;
    for (let ch = 0; ch < fmt.channels; ch += 1) {
      const at = data.offset + (i * fmt.channels + ch) * (fmt.bits / 8);
      let v = 0;
      if (fmt.bits === 16) v = view.getInt16(at, true) / 0x8000;
      else if (fmt.bits === 8) v = (view.getUint8(at) - 128) / 128;
      else if (fmt.bits === 24) {
        const b = view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getUint8(at + 2) << 16);
        v = (b & 0x800000 ? b | ~0xffffff : b) / 0x800000;
      }
      sum = Math.max(sum, Math.abs(v));
      if (ch === 0) v = v;
    }
    out[i] = sum;
  }
  return { samples: out, sampleRate: fmt.sampleRate, channels: fmt.channels, bits: fmt.bits };
}

// separate mono mix for rms
function decodeWavMix(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= view.byteLength) {
    const id = view.getUint32(offset, false);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 0x666d7420) fmt = { channels: view.getUint16(body + 2, true), sampleRate: view.getUint32(body + 4, true), bits: view.getUint16(body + 14, true) };
    if (id === 0x64617461) data = { offset: body, size };
    offset = body + size + (size % 2);
  }
  const frames = Math.floor(data.size / (fmt.channels * (fmt.bits / 8)));
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    let sum = 0;
    for (let ch = 0; ch < fmt.channels; ch += 1) {
      const at = data.offset + (i * fmt.channels + ch) * (fmt.bits / 8);
      let v = 0;
      if (fmt.bits === 16) v = view.getInt16(at, true) / 0x8000;
      else if (fmt.bits === 8) v = (view.getUint8(at) - 128) / 128;
      sum += v / fmt.channels;
    }
    out[i] = sum;
  }
  return { samples: out, sampleRate: fmt.sampleRate };
}

const db = (v) => (20 * Math.log10(Math.max(v, 1e-9))).toFixed(1);

for (const [id, url] of Object.entries(URLS)) {
  const res = await fetch(url);
  const buf = new Uint8Array(await res.arrayBuffer());
  const { samples, sampleRate, channels, bits } = decodeWavMix(buf);
  let peak = 0;
  let peakAt = 0;
  let sumSq = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const a = Math.abs(samples[i]);
    if (a > peak) { peak = a; peakAt = i; }
    sumSq += a * a;
  }
  const rms = Math.sqrt(sumSq / samples.length);
  let onset = 0;
  for (let i = 0; i < samples.length; i += 1) {
    if (Math.abs(samples[i]) > peak * 0.1) { onset = i; break; }
  }
  // RMS of first 50ms (body of the hit) and first 200ms
  const w50 = Math.min(samples.length, Math.floor(sampleRate * 0.05));
  const w200 = Math.min(samples.length, Math.floor(sampleRate * 0.2));
  let s50 = 0; let s200 = 0;
  for (let i = 0; i < w200; i += 1) { const a = samples[i] * samples[i]; if (i < w50) s50 += a; s200 += a; }
  const rms50 = Math.sqrt(s50 / w50);
  const rms200 = Math.sqrt(s200 / w200);
  console.log([
    id.padEnd(8),
    `sr=${sampleRate} ch=${channels} bits=${bits} len=${(samples.length / sampleRate).toFixed(2)}s`,
    `peak=${db(peak)}dB @${(peakAt / sampleRate * 1000).toFixed(1)}ms`,
    `onset=${(onset / sampleRate * 1000).toFixed(1)}ms`,
    `rms=${db(rms)}dB rms50=${db(rms50)}dB rms200=${db(rms200)}dB`,
  ].join('  '));
}
