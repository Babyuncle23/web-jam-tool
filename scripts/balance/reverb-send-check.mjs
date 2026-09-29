/**
 * One-off check for the shared send-reverb refactor: renders a short note
 * through the real instrument bus in Tone.Offline, once with the default
 * FX amounts and once with all reverbs at 0, and prints tail RMS so the
 * wet path is provably alive.
 *
 * Usage: node scripts/balance/reverb-send-check.mjs [base-url]
 */
import puppeteer from 'puppeteer-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:43117';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  protocolTimeout: 120000,
  args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox', '--mute-audio'],
});

try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  await page.goto(`${BASE}/?role=host`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('typeof Tone !== "undefined"', { timeout: 20000 });

  const report = await page.evaluate(async () => {
    const Tone = globalThis.Tone;
    const { createInstrumentBus, defaultFxState } = await import('/src/audio/effects.js');
    const { TouchSynth } = await import('/src/audio/synth.js');
    const engine = { tone: Tone };

    const rms = (buffer, from, to) => {
      const raw = buffer.get();
      const sr = raw.sampleRate;
      let sum = 0;
      let frames = 0;
      for (let ch = 0; ch < raw.numberOfChannels; ch += 1) {
        const data = raw.getChannelData(ch);
        for (let i = Math.floor(from * sr); i < Math.min(raw.length, Math.floor(to * sr)); i += 1) {
          sum += data[i] * data[i];
          frames += 1;
        }
      }
      return +(20 * Math.log10(Math.max(Math.sqrt(sum / Math.max(1, frames)), 1e-9))).toFixed(1);
    };

    const render = async (instrument, fxId, amount) => {
      const buf = await Tone.Offline(async () => {
        const dest = new Tone.Gain(1).toDestination();
        const bus = createInstrumentBus(Tone);
        await bus.ready;
        bus.mix.connect(dest);
        bus.setLevel(instrument, 0.8);
        if (fxId) bus.setEffect(instrument, fxId, amount);
        const synth = new TouchSynth(engine, bus, { root: 'C', scale: 'major' });
        const transport = Tone.getTransport();
        transport.schedule((time) => synth.attack({ id: 't', instrument, x: 0.5, y: 0.5, mode: 'single', time }), 0.05);
        transport.schedule((time) => synth.release('t', time), 0.8);
        transport.start(0);
      }, 3.5);
      return {
        held: rms(buf, 0.2, 0.7),
        tail: rms(buf, 1.0, 3.0),
      };
    };

    const out = {};
    for (const [instrument, fxId] of [
      ['pad', 'reverb'],
      ['organ', 'room'],
      ['kalimba', 'reverb'],
      ['synth', 'room'],
    ]) {
      const dry = await render(instrument, null, 0);
      const wet = await render(instrument, fxId, defaultFxState()[instrument][fxId]);
      out[`${instrument}.${fxId}`] = { dry, wet };
    }
    // Full defaults on every instrument at once, like a real jam.
    const all = await Tone.Offline(async () => {
      const dest = new Tone.Gain(1).toDestination();
      const bus = createInstrumentBus(Tone);
      await bus.ready;
      bus.mix.connect(dest);
      const fx = defaultFxState();
      for (const instrument of ['pad', 'bass', 'organ', 'kalimba', 'synth']) {
        bus.setLevel(instrument, 0.8);
        for (const [id, amount] of Object.entries(fx[instrument])) bus.setEffect(instrument, id, amount);
      }
      const synth = new TouchSynth(engine, bus, { root: 'C', scale: 'major' });
      const transport = Tone.getTransport();
      for (const [i, instrument] of ['pad', 'bass', 'organ', 'kalimba', 'synth'].entries()) {
        transport.schedule((time) => synth.attack({ id: `t${i}`, instrument, x: 0.5, y: 0.5, mode: 'single', time }), 0.1 + i * 0.2);
        transport.schedule((time) => synth.release(`t${i}`, time), 1.4);
      }
      transport.start(0);
    }, 4);
    out.fullDefaults = { held: rms(all, 0.3, 1.3), tail: rms(all, 1.6, 3.8) };
    return out;
  });

  for (const [k, v] of Object.entries(report)) console.log(k.padEnd(18), JSON.stringify(v));
} finally {
  await browser.close();
}
