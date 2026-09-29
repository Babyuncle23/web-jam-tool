/**
 * Audio-graph cost check for the send-reverb refactor. Times how long
 * Tone.Offline needs to render the full bus + drum chain with default FX —
 * offline rendering is single-threaded DSP, so wall time tracks the real
 * audio-thread cost of the graph.
 *
 * Usage: node scripts/balance/reverb-perf-check.mjs [base-url] [effects-path] [lite]
 *   effects-path defaults to /src/audio/effects.js; pass
 *   /src/audio/effects-legacy-check.js to measure the pre-change code.
 *   'lite' as the third argument builds the graph with the LITE profile.
 */
import puppeteer from 'puppeteer-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:43117';
const EFFECTS = process.argv[3] ?? '/src/audio/effects.js';
const LITE_MODE = process.argv[4] === 'lite';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const REPS = 5;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  protocolTimeout: 240000,
  args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox', '--mute-audio'],
});

try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  await page.goto(`${BASE}/?role=host`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('typeof Tone !== "undefined"', { timeout: 20000 });

  const times = await page.evaluate(async (effectsPath, reps, liteMode) => {
    const Tone = globalThis.Tone;
    const { createInstrumentBus, createDrumBus, defaultFxState, LITE } = await import(effectsPath);
    const { TouchSynth } = await import('/src/audio/synth.js');
    const { DrumMachine } = await import('/src/audio/drums.js');
    const engine = { tone: Tone };
    const fx = defaultFxState();
    const lite = liteMode ? LITE : null;
    const out = [];
    for (let rep = 0; rep < reps; rep += 1) {
      const t0 = performance.now();
      await Tone.Offline(async () => {
        const dest = new Tone.Gain(1).toDestination();
        const bus = createInstrumentBus(Tone, lite);
        const drumsFx = createDrumBus(Tone, lite);
        await Promise.all([bus.ready, drumsFx.ready]);
        bus.mix.connect(dest);
        const drums = new DrumMachine(engine, { pattern: {} });
        drums.output.connect(drumsFx.input);
        drumsFx.output.connect(dest);
        const synth = new TouchSynth(engine, bus, { root: 'C', scale: 'major', lite });
        for (const instrument of ['pad', 'bass', 'organ', 'kalimba', 'synth']) {
          bus.setLevel(instrument, 0.8);
          for (const [id, amount] of Object.entries(fx[instrument])) bus.setEffect(instrument, id, amount);
        }
        for (const [id, amount] of Object.entries(fx.drums)) drumsFx.setEffect(id, amount);
        const transport = Tone.getTransport();
        for (const [i, instrument] of ['pad', 'bass', 'organ', 'kalimba', 'synth'].entries()) {
          transport.schedule((time) => synth.attack({ id: `t${i}`, instrument, x: 0.5, y: 0.5, mode: 'chords', time }), 0.1 + i * 0.6);
          transport.schedule((time) => synth.release(`t${i}`, time), 3.4);
        }
        for (let s = 0; s < 16; s += 4) drums.setStep('kick', s, true);
        for (let s = 4; s < 16; s += 8) drums.setStep('snare', s, true);
        drums.start();
        transport.bpm.value = 96;
        transport.start(0);
      }, 4);
      out.push(Math.round(performance.now() - t0));
    }
    return out;
  }, EFFECTS, REPS, LITE_MODE);

  console.log(EFFECTS, LITE_MODE ? '(lite)' : '', '→', times.join(' ms, '), 'ms   median:', times.sort((a, b) => a - b)[Math.floor(times.length / 2)], 'ms');
} finally {
  await browser.close();
}
