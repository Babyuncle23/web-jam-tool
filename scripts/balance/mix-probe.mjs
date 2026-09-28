/**
 * Mix balance probe. Opens the host page headless, renders every drum voice
 * (samples and synth fallback) and every instrument solo through the real
 * buses in Tone.Offline, then prints peak/RMS per voice.
 *
 * Usage: node scripts/balance/mix-probe.mjs [base-url]
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
    const { DrumMachine, TRACKS } = await import('/src/audio/drums.js');
    const { createInstrumentBus, createDrumBus, createMasterFx } = await import('/src/audio/effects.js');
    const { TouchSynth } = await import('/src/audio/synth.js');

    const stats = (buffer, from = 0, to = Infinity) => {
      const raw = typeof buffer.get === 'function' ? buffer.get() : buffer;
      const sr = raw.sampleRate;
      const a = Math.floor(from * sr);
      const b = Math.min(raw.length, to === Infinity ? raw.length : Math.floor(to * sr));
      let peak = 0;
      let sum = 0;
      for (let ch = 0; ch < raw.numberOfChannels; ch += 1) {
        const data = raw.getChannelData(ch);
        for (let i = a; i < b; i += 1) {
          const v = Math.abs(data[i]);
          if (v > peak) peak = v;
          sum += v * v;
        }
      }
      const rms = Math.sqrt(sum / Math.max(1, (b - a) * raw.numberOfChannels));
      const db = (v) => +(20 * Math.log10(Math.max(v, 1e-9))).toFixed(1);
      return { peak: db(peak), rms: db(rms) };
    };

    const render = async (seconds, fn) => stats(await Tone.Offline(fn, seconds));

    const out = { drums: {}, instruments: {} };
    const engine = { tone: Tone };

    for (const track of TRACKS) {
      for (const kind of ['synth', 'sample']) {
        out.drums[`${track.id}:${kind}`] = await render(2.2, async () => {
          const dest = new Tone.Gain(1).toDestination();
          const drums = new DrumMachine(engine, { pattern: {} });
          drums.output.connect(dest);
          if (kind === 'sample') await drums.loadSamples();
          drums.setStep(track.id, 0, true);
          drums.start();
          Tone.getTransport().start(0);
        });
      }
    }

    const instrumentRender = async (instrument, mode) => Tone.Offline(async () => {
      const dest = new Tone.Gain(1).toDestination();
      const bus = createInstrumentBus(Tone);
      await bus.ready;
      bus.mix.connect(dest);
      bus.setLevel(instrument, 0.8);
      const synth = new TouchSynth(engine, bus, { root: 'C', scale: 'major' });
      const transport = Tone.getTransport();
      transport.schedule((time) => synth.attack({ id: 't', instrument, x: 0.5, y: mode === 'chords' ? 0.1 : 0.5, mode, time }), 0.05);
      transport.schedule((time) => synth.release('t', time), 0.9);
      transport.start(0);
    }, 1.6);

    for (const instrument of ['pad', 'bass', 'organ', 'kalimba', 'synth']) {
      const single = await instrumentRender(instrument, 'single');
      out.instruments[instrument] = stats(single);
      out.instruments[`${instrument}:held`] = stats(single, 0.2, 0.8);
      out.instruments[`${instrument}:chord`] = stats(await instrumentRender(instrument, 'chords'));
    }

    // Full-mix render through the complete master chain: drum preset "break"
    // plus one held chord per instrument at level 0.8, into
    // master 0.78 -> compressor -> masterFx -> limiter(-2).
    out.fullMix = await render(4.5, async () => {
      const limiter = new Tone.Limiter(-2).toDestination();
      const compressor = new Tone.Compressor({ threshold: -16, ratio: 2.2, attack: 0.012, release: 0.22, knee: 8 });
      const masterFx = createMasterFx(Tone, 96);
      compressor.connect(masterFx.input);
      masterFx.output.connect(limiter);
      const master = new Tone.Gain(0.78).connect(compressor);
      const bus = createInstrumentBus(Tone);
      const drumsFx = createDrumBus(Tone);
      await Promise.all([bus.ready, drumsFx.ready]);
      bus.mix.connect(master);
      const drums = new DrumMachine(engine);
      drums.output.connect(drumsFx.input);
      drumsFx.output.connect(master);
      await drums.loadSamples();
      for (const instrument of ['pad', 'bass', 'organ', 'kalimba', 'synth']) bus.setLevel(instrument, 0.8);
      const synth = new TouchSynth(engine, bus, { root: 'C', scale: 'major' });
      const transport = Tone.getTransport();
      for (const [i, instrument] of ['pad', 'bass', 'organ', 'kalimba', 'synth'].entries()) {
        transport.schedule((time) => synth.attack({ id: `t${i}`, instrument, x: 0.3 + i * 0.1, y: 0.5, mode: 'single', time }), 0.1 + i * 0.4);
        transport.schedule((time) => synth.release(`t${i}`, time), 3.9);
      }
      drums.start();
      transport.bpm.value = 96;
      transport.start(0);
    });
    return out;
  });

  const line = (name, s) => console.log(name.padEnd(22), `peak=${String(s.peak).padStart(6)}dB  rms=${String(s.rms).padStart(6)}dB`);
  console.log('--- drums ---');
  for (const [k, v] of Object.entries(report.drums)) line(k, v);
  console.log('--- instruments (single note, level 0.8) ---');
  for (const [k, v] of Object.entries(report.instruments)) line(k, v);
  console.log('--- full mix through limiter ---');
  line('fullMix', report.fullMix);
} finally {
  await browser.close();
}
