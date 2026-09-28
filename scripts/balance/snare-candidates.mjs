/**
 * Probe candidate 808 snare WAVs from the Fischer set and rank them by
 * brightness (energy >1.5kHz and >3kHz) so we can pick a less muffled snare.
 */
const CDN = 'https://cdn.jsdelivr.net/gh/fluid-music/open-drums/tr-808/TR808WAV';
const NAMES = ['SD0000','SD0010','SD0025','SD0050','SD0075','SD2525','SD2550','SD2575','SD5050','SD5075','SD7550','SD7575','SD1000','SD1050','SD1100'];

function decode(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let offset = 12, fmt = null, data = null;
  while (offset + 8 <= view.byteLength) {
    const id = view.getUint32(offset, false), size = view.getUint32(offset + 4, true), body = offset + 8;
    if (id === 0x666d7420) fmt = { ch: view.getUint16(body + 2, true), sr: view.getUint32(body + 4, true), bits: view.getUint16(body + 14, true) };
    if (id === 0x64617461) data = { offset: body, size };
    offset = body + size + (size % 2);
  }
  if (!fmt || !data) return null;
  const frames = Math.floor(data.size / (fmt.ch * fmt.bits / 8));
  const s = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let m = 0;
    for (let c = 0; c < fmt.ch; c++) {
      const at = data.offset + (i * fmt.ch + c) * (fmt.bits / 8);
      let v = 0;
      if (fmt.bits === 16) v = view.getInt16(at, true) / 0x8000;
      else if (fmt.bits === 8) v = (view.getUint8(at) - 128) / 128;
      m = Math.max(m, Math.abs(v));
    }
    s[i] = m;
  }
  return { s, sr: fmt.sr };
}

const db = (v) => +(20 * Math.log10(Math.max(v, 1e-9))).toFixed(1);

for (const name of NAMES) {
  const res = await fetch(`${CDN}/SD/${name}.WAV`).catch(() => null);
  if (!res || !res.ok) { console.log(name, 'MISS', res?.status); continue; }
  const wav = decode(new Uint8Array(await res.arrayBuffer()));
  if (!wav) { console.log(name, 'BAD'); continue; }
  const { s, sr } = wav;
  const w = Math.min(s.length, Math.floor(sr * 0.05));
  const aPres = (() => { const rc = 1 / (2 * Math.PI * 1500); return rc / (rc + 1 / sr); })();
  const aAir = (() => { const rc = 1 / (2 * Math.PI * 3000); return rc / (rc + 1 / sr); })();
  let lpP = 0, lpA = 0, peak = 0, sum = 0, pSum = 0, aSum = 0, peakAt = 0;
  for (let i = 0; i < w; i++) {
    const v = s[i];
    lpP += aPres * (v - lpP); lpA += aAir * (v - lpA);
    pSum += (v - lpP) ** 2; aSum += (v - lpA) ** 2; sum += v * v;
    if (Math.abs(v) > peak) { peak = Math.abs(v); peakAt = i; }
  }
  console.log([
    name.padEnd(7),
    `len=${(s.length / sr).toFixed(2)}s`,
    `peak=${db(peak)}dB @${(peakAt / sr * 1000).toFixed(1)}ms`,
    `rms50=${db(Math.sqrt(sum / w))}dB`,
    `pres=${db(Math.sqrt(pSum / w))}dB`,
    `hf=${db(Math.sqrt(aSum / w))}dB`,
  ].join('  '));
}
