/**
 * Lite drum-bus balance check. Renders the same 808 pattern through the full
 * drum bus (default drive/room wets applied) and through the lite bus, then
 * prints peak/RMS plus the air-band energy so the lite makeup can be tuned to
 * match the level and brightness the distortion added.
 *
 * Usage: node scripts/balance/drum-lite-check.mjs [base-url]
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
    const { DrumMachine } = await import('/src/audio/drums.js');
    const { createDrumBus, defaultFxState, LITE } = await import('/src/audio/effects.js');

    const stats = (buffer) => {
      const raw = typeof buffer.get === 'function' ? buffer.get() : buffer;
      const sr = raw.sampleRate;
      const alphaOf = (fc) => { const rc = 1 / (2 * Math.PI * fc); return rc / (rc + 1 / sr); };
      const aAir = alphaOf(3000);
      let peak = 0;
      let sum = 0;
      let hfSum = 0;
      for (let ch = 0; ch < raw.numberOfChannels; ch += 1) {
        const data = raw.getChannelData(ch);
        let lpAir = 0;
        for (let i = 0; i < raw.length; i += 1) {
          const v = data[i];
          lpAir += aAir * (v - lpAir);
          hfSum += (v - lpAir) * (v - lpAir);
          const m = Math.abs(v);
          if (m > peak) peak = m;
          sum += v * v;
        }
      }
      const frames = raw.length * raw.numberOfChannels;
      const db = (v) => +(20 * Math.log10(Math.max(v, 1e-9))).toFixed(1);
      return { peak: db(peak), rms: db(Math.sqrt(sum / frames)), hf: db(Math.sqrt(hfSum / frames)) };
    };

    const PATTERN = {
      kick: [0, 4, 8, 12],
      snare: [4, 12],
      hat: [0, 2, 4, 6, 8, 10, 12, 14],
      openhat: [6, 14],
      clap: [12],
      tom: [0, 7],
      cowbell: [2, 10],
    };

    const render = async (lite) => {
      const buf = await Tone.Offline(async () => {
        const dest = new Tone.Gain(1).toDestination();
        const drumsFx = createDrumBus(Tone, lite ? LITE : null);
        await drumsFx.ready;
        const engine = { tone: Tone };
        const drums = new DrumMachine(engine, { pattern: {} });
        drums.output.connect(drumsFx.input);
        drumsFx.output.connect(dest);
        await drums.loadSamples();
        for (const track of Object.keys(PATTERN)) {
          for (const step of PATTERN[track]) drums.setStep(track, step, true);
        }
        if (!lite) {
          for (const [id, amount] of Object.entries(defaultFxState().drums)) drumsFx.setEffect(id, amount);
        }
        drums.start();
        Tone.getTransport().bpm.value = 96;
        Tone.getTransport().start(0);
      }, 2.5);
      return stats(buf);
    };

    return { full: await render(false), lite: await render(true) };
  });

  const line = (name, s) => console.log(name.padEnd(6), `peak=${String(s.peak).padStart(6)}dB  rms=${String(s.rms).padStart(6)}dB  air=${String(s.hf).padStart(6)}dB`);
  line('full', report.full);
  line('lite', report.lite);
  const delta = (a, b) => +(b - a).toFixed(1);
  console.log('lite − full:', `peak=${delta(report.full.peak, report.lite.peak)}dB  rms=${delta(report.full.rms, report.lite.rms)}dB  air=${delta(report.full.hf, report.lite.hf)}dB`);
} finally {
  await browser.close();
}
