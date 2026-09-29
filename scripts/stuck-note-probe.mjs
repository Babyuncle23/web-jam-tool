/**
 * Stuck-note probe: drives the host pad with synthetic pointer events and
 * reports instrument voices that keep sounding after every finger is up.
 *
 * A voice counts as "held" while a Tone.Monophonic between triggerAttack and
 * triggerRelease. A voice counts as "ringing" when its amplitude envelope is
 * above zero — that catches the worse failure mode where a release was issued
 * but the attack was still pending on the transport clock and re-armed the
 * envelope afterwards.
 *
 * A recorded loop note legitimately re-attacks every cycle, so a single
 * sample can land inside its sounding span and look identical to a stuck
 * voice. Any flagged voice is therefore re-verified one full loop cycle
 * later: only an attack that outlived the whole cycle without a release is
 * reported as stuck.
 *
 * Usage: node scripts/stuck-note-probe.mjs [--url http://127.0.0.1:43117] [--debug 1]
 * Requires the dev server and a Chrome binary. --debug wraps TouchSynth
 * attack/release/choke and dumps the recorder's events on a real failure.
 */

import puppeteer from 'puppeteer-core';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .join(' ')
    .matchAll(/--([\w-]+)[= ]([^\s]+)/g)
    .map((match) => [match[1], match[2]]),
);

const BASE_URL = args.url ?? 'http://127.0.0.1:43117';
const CHROME = args.chrome ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG = 'debug' in args || process.env.STUCK_DEBUG === '1';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs inside the page before audio starts: wraps Monophonic note on/off. */
function instrumentVoices() {
  const Tone = globalThis.Tone;
  window.__voices = new Set();
  window.__missed = [];
  window.__deferred = [];
  // Monophonic is not exported on the global; Synth and FMSynth inherit their
  // triggerAttack/triggerRelease from it, so shadow-patching their prototypes
  // catches the glide pools, the bass and every PolySynth inner voice.
  for (const Ctor of [Tone.Synth, Tone.FMSynth]) {
    const proto = Ctor.prototype;
    const origAttack = proto.triggerAttack;
    const origRelease = proto.triggerRelease;
    proto.triggerAttack = function patchedAttack(note, ...rest) {
      window.__voices.add(this);
      this.__held = true;
      this.__note = note;
      (this.__log ||= []).push({ ev: 'A', note, at: rest[0], now: Tone.now() });
      if (!this.__envWrapped && this.envelope) {
        this.__envWrapped = true;
        const env = this.envelope;
        const sig = env._sig || env.output || env;
        const origRel = env.triggerRelease;
        env.triggerRelease = (t, ...r) => {
          const gv = typeof sig.getValueAtTime === 'function' ? sig.getValueAtTime(t) : null;
          this.__log.push({ ev: 'ER', at: t, gv, now: Tone.now() });
          return origRel.call(env, t, ...r);
        };
        const origAtk = env.triggerAttack;
        env.triggerAttack = (t, ...r) => {
          this.__log.push({ ev: 'EA', at: t, now: Tone.now() });
          return origAtk.call(env, t, ...r);
        };
      }
      return origAttack.call(this, note, ...rest);
    };
    proto.triggerRelease = function patchedRelease(...rest) {
      this.__held = false;
      (this.__log ||= []).push({ ev: 'R', at: rest[0], now: Tone.now() });
      return origRelease.apply(this, rest);
    };
  }
  // Watch PolySynth deferrals and release lookups that find no voice.
  // NOTE: _activeVoices[].midi actually stores the raw incoming value
  // (a frequency here), so releases are matched by exact float equality.
  const poly = Tone.PolySynth.prototype;
  const origSched = poly._scheduleEvent;
  poly._scheduleEvent = function (type, note, time, vel) {
    const now = this.now();
    if (time > now) window.__deferred.push({ type, note, time, now });
    return origSched.call(this, type, note, time, vel);
  };
  const origTrigRel = poly._triggerRelease;
  poly._triggerRelease = function (notes, time) {
    for (const note of Array.isArray(notes) ? notes : [notes]) {
      const found = this._activeVoices.some((v) => Math.abs(v.midi - note) < 0.001 && !v.released);
      if (!found) {
        window.__missed.push({ note, time, now: Tone.now(), active: this._activeVoices.map((v) => ({ m: v.midi, r: v.released })) });
      }
    }
    return origTrigRel.call(this, notes, time);
  };
}

/** Debug: wrap TouchSynth entry points to trace id-level attack/release. */
function instrumentSynthOps() {
  const Tone = globalThis.Tone;
  const synth = globalThis.__jam?.audio?.synth;
  if (!synth) return;
  window.__ops = [];
  const stamp = (op, data) => window.__ops.push({ op, now: Tone.now(), ...data });
  for (const name of ['attack', 'move', 'release', 'choke', 'releaseMatching', 'silence']) {
    const orig = synth[name].bind(synth);
    synth[name] = (...callArgs) => {
      const out = orig(...callArgs);
      const arg = callArgs[0];
      stamp(name, { id: arg?.id ?? arg, ok: out === undefined ? '-' : out, inst: arg?.instrument, type: arg?.type });
      return out;
    };
  }
}

/** Debug snapshot: recent synth ops plus every recorder's raw events. */
function debugDump() {
  const loops = {};
  for (const [playerId, recorder] of globalThis.__jam?.audio?.loops ?? []) {
    loops[playerId] = recorder.exportEvents();
  }
  return { ops: (window.__ops || []).slice(-80), loops };
}

/**
 * Snapshot every tracked voice so a later compare can tell a real stuck voice
 * from a transient mid-span read — a recorded loop note legitimately replays
 * and looks identical to a stuck one in a single sample.
 */
function snapshotVoices() {
  window.__snap = [...window.__voices].map((voice) => ({
    voice,
    logLen: (voice.__log || []).length,
  }));
}

/**
 * One loop cycle in ms: a legit note's span is always shorter than the loop,
 * so any voice still unreleased after this wait cannot be a recorded note.
 */
function loopCycleMs() {
  const Tone = globalThis.Tone;
  const steps = globalThis.__jam?.loopFor?.('host')?.loopSteps ?? 32;
  return Math.max(2000, steps * Tone.Time('16n').toSeconds() * 1000 + 600);
}

/**
 * Voices still ringing since the snapshot that never got a note-off. A
 * release anywhere in the new log tail clears the voice; an attack older
 * than a whole loop cycle with no release since outlived every legit span.
 */
function stillRinging() {
  const Tone = globalThis.Tone;
  const now = Tone.now();
  const steps = globalThis.__jam?.loopFor?.('host')?.loopSteps ?? 32;
  const cycleSec = steps * Tone.Time('16n').toSeconds();
  const out = [];
  for (const { voice, logLen } of window.__snap || []) {
    const tail = (voice.__log || []).slice(logLen);
    if (tail.some((event) => event.ev === 'R')) continue;
    const osc = voice.oscillator?.state || voice._oscillator?.state || '?';
    if (osc === 'stopped') continue;
    let envNow = 0;
    try {
      envNow = voice.envelope?.getValueAtTime?.(now) ?? 0;
    } catch {
      // no envelope
    }
    const log = voice.__log || [];
    // Oldest unreleased attack: a voice that re-fires its 'on' every cycle
    // without ever releasing stays held — age the hold, not the latest attack.
    let heldSince = null;
    for (let i = log.length - 1; i >= 0; i -= 1) {
      if (log[i].ev === 'A') heldSince = log[i].now;
      else if (log[i].ev === 'R') break;
    }
    const aged = voice.__held ? heldSince != null && now - heldSince > cycleSec : envNow > 0.02;
    if ((voice.__held || envNow > 0.02) && aged) {
      out.push({
        ctor: voice.constructor?.name || voice.name || '?',
        held: Boolean(voice.__held),
        note: voice.__note,
        envNow: Number(envNow.toFixed(3)),
        osc,
        newEvents: tail,
        log: log.slice(-14),
      });
    }
  }
  return out;
}

/** Voices that never got their release, or whose envelope is still up. */
function stuckVoices() {
  const Tone = globalThis.Tone;
  const now = Tone.now();
  const out = [];
  for (const voice of window.__voices) {
    let envNow = 0;
    let envSoon = 0;
    try {
      envNow = voice.envelope?.getValueAtTime?.(now) ?? 0;
      envSoon = voice.envelope?.getValueAtTime?.(now + 0.5) ?? 0;
    } catch {
      // no envelope on this voice type
    }
    const osc = voice.oscillator?.state || voice._oscillator?.state || '?';
    // A stopped oscillator cannot sound regardless of the envelope value.
    const ringing = osc !== 'stopped' && (voice.__held || envSoon > 0.02);
    if (ringing) {
      out.push({
        ctor: voice.constructor?.name || voice.name || '?',
        held: Boolean(voice.__held),
        note: voice.__note,
        envNow: Number(envNow.toFixed(3)),
        envSoon: Number(envSoon.toFixed(3)),
        osc,
        log: (voice.__log || []).slice(-14),
      });
    }
  }
  return out;
}

/** Dispatch a synthetic pointer event onto the host pad. */
function firePointer(type, pointerId, x, y) {
  const pad = document.getElementById('host-pad');
  const rect = pad.getBoundingClientRect();
  pad.dispatchEvent(
    new PointerEvent(type, {
      pointerId,
      clientX: rect.left + rect.width * x,
      clientY: rect.top + rect.height * (1 - y),
      bubbles: true,
      pointerType: 'touch',
      isPrimary: pointerId === 1,
      pressure: 0.5,
    }),
  );
}

async function launch() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'shell',
    args: [
      '--no-sandbox',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--mute-audio',
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  page.on('console', (message) => {
    if (['error', 'warning'].includes(message.type())) console.log(`  [page ${message.type()}] ${message.text()}`);
  });
  page.on('pageerror', (error) => console.log(`  [pageerror] ${error.message}`));
  await page.goto(`${BASE_URL}/?role=host`, { waitUntil: 'networkidle2' });
  await page.evaluate(instrumentVoices);
  await page.waitForSelector('#splash-start');
  await page.evaluate(() => document.getElementById('splash-start').click());
  await page.waitForFunction(() => document.getElementById('host-audio-status').dataset.state === 'online', {
    timeout: 20000,
  });
  if (DEBUG) await page.evaluate(instrumentSynthOps);
  return { browser, page };
}

const report = [];

function record(name, stuck) {
  report.push({ scenario: name, stuck });
  console.log(`${stuck.length ? 'FAIL' : 'ok  '} ${name}${stuck.length ? ` → ${JSON.stringify(stuck)}` : ''}`);
}

async function pickInstrument(page, instrument) {
  await page.evaluate((id) => {
    document.querySelector(`#instrument-row [data-instrument="${id}"]`)?.click();
  }, instrument);
}

/**
 * Settle, sample, and — only when something rings — prove it is actually
 * stuck: a recorded loop note caught mid-span gets its release within one
 * loop cycle, a stuck voice never does.
 */
async function checkStuck(page, settleMs = 400) {
  await sleep(settleMs);
  const flagged = await page.evaluate(stuckVoices);
  if (!flagged.length) return [];
  await page.evaluate(snapshotVoices);
  await sleep(await page.evaluate(loopCycleMs));
  const stuck = await page.evaluate(stillRinging);
  if (DEBUG && stuck.length) {
    const dump = await page.evaluate(debugDump);
    console.log('  ops tail:', JSON.stringify(dump.ops.slice(-40)));
    console.log('  loops:', JSON.stringify(dump.loops));
  }
  return stuck;
}

/** btn-loop-clear only listens to pointerdown/up (hold = clear all): a plain .click() is a no-op, so tap it with real pointer events — a short tap clears the host's own loop. */
async function pressClear(page) {
  await page.evaluate(() => {
    const btn = document.getElementById('btn-loop-clear');
    btn.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, bubbles: true }));
    btn.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true }));
  });
}

const { browser, page } = await launch();

// --- Scenario 1: plain tap on every instrument -------------------------
for (const instrument of ['pad', 'organ', 'kalimba', 'synth', 'bass']) {
  await pickInstrument(page, instrument);
  await page.evaluate(firePointer, 'pointerdown', 1, 0.4, 0.5);
  await sleep(300);
  await page.evaluate(firePointer, 'pointerup', 1, 0.4, 0.5);
  record(`tap ${instrument}`, await checkStuck(page));
}

// --- Scenario 2: press, slide across columns, release ------------------
for (const instrument of ['pad', 'organ']) {
  await pickInstrument(page, instrument);
  await page.evaluate(firePointer, 'pointerdown', 1, 0.2, 0.5);
  for (let i = 1; i <= 8; i += 1) {
    await page.evaluate(firePointer, 'pointermove', 1, 0.2 + i * 0.08, 0.5);
    await sleep(60);
  }
  await page.evaluate(firePointer, 'pointerup', 1, 0.84, 0.5);
  record(`slide ${instrument}`, await checkStuck(page));
}

// --- Scenario 3: chords mode, two overlapping fingers -------------------
await page.evaluate(() => {
  document.querySelector('#mode-row [data-mode="chords"]')?.click();
});
for (const instrument of ['organ', 'pad']) {
  await pickInstrument(page, instrument);
  await page.evaluate(firePointer, 'pointerdown', 1, 0.3, 0.4);
  await sleep(250);
  await page.evaluate(firePointer, 'pointerdown', 2, 0.6, 0.6);
  await sleep(250);
  await page.evaluate(firePointer, 'pointerup', 2, 0.6, 0.6);
  await page.evaluate(firePointer, 'pointerup', 1, 0.3, 0.4);
  record(`chords two fingers ${instrument}`, await checkStuck(page));
}
await page.evaluate(() => {
  document.querySelector('#mode-row [data-mode="single"]')?.click();
});

// --- Scenario 4: record a held note, stop recording mid-hold -----------
await pickInstrument(page, 'organ');
await page.evaluate(() => document.getElementById('btn-loop').click());
await sleep(200);
await page.evaluate(firePointer, 'pointerdown', 1, 0.5, 0.5);
await sleep(400);
await page.evaluate(() => document.getElementById('btn-loop').click()); // stop rec while held
await page.evaluate(firePointer, 'pointerup', 1, 0.5, 0.5);
await page.evaluate(() => document.getElementById('btn-transport').click()); // stop transport
await sleep(300);
await page.evaluate(() => document.getElementById('btn-transport').click()); // restart so the loop plays
await sleep(2500); // let at least one loop boundary pass
record('rec stopped mid-hold (organ)', await checkStuck(page, 0));
// cleanup the recorded drone
await pressClear(page);
await sleep(300);

// --- Scenario 5: long note, then shrink the loop (bars 32→64→16) -------
await pickInstrument(page, 'organ');
await page.evaluate(() => document.getElementById('btn-loop').click());
await sleep(200);
await page.evaluate(firePointer, 'pointerdown', 1, 0.5, 0.5);
await sleep(2600); // ~20 sixteenths at 120bpm — an 'up' beyond step 16
await page.evaluate(firePointer, 'pointerup', 1, 0.5, 0.5);
await page.evaluate(() => document.getElementById('btn-loop').click()); // stop rec
await sleep(300);
await page.evaluate(() => document.getElementById('btn-bars').click()); // 32 → 64
await sleep(200);
await page.evaluate(() => document.getElementById('btn-bars').click()); // 64 → 16
await sleep(500);
record('shrink loop below note end (organ)', await checkStuck(page, 0));
await pressClear(page);
await sleep(300);

// --- Scenario 6: record, flip Notes→Chords while the finger is down -----
await pickInstrument(page, 'organ');
await page.evaluate(() => document.getElementById('btn-loop').click());
await sleep(200);
await page.evaluate(firePointer, 'pointerdown', 1, 0.5, 0.5);
await sleep(250);
await page.evaluate(() => document.querySelector('#mode-row [data-mode="chords"]')?.click());
await sleep(250);
await page.evaluate(firePointer, 'pointerup', 1, 0.5, 0.5);
await page.evaluate(() => document.querySelector('#mode-row [data-mode="single"]')?.click());
// The orphaned take rings while the loop keeps playing — check before stop.
await sleep(2600);
record('mode flip mid-hold (organ)', await checkStuck(page, 0));
await page.evaluate(() => document.getElementById('btn-loop').click()); // stop rec
await sleep(300);
await pressClear(page);
await sleep(300);

// --- Scenario 7: record, flip Chords→Notes while the finger is down -----
await pickInstrument(page, 'organ');
await page.evaluate(() => document.querySelector('#mode-row [data-mode="chords"]')?.click());
await page.evaluate(() => document.getElementById('btn-loop').click());
await sleep(200);
await page.evaluate(firePointer, 'pointerdown', 1, 0.5, 0.5);
await sleep(250);
await page.evaluate(() => document.querySelector('#mode-row [data-mode="single"]')?.click());
await sleep(250);
await page.evaluate(firePointer, 'pointerup', 1, 0.5, 0.5);
await sleep(2600);
record('mode flip chord→note (organ)', await checkStuck(page, 0));
await page.evaluate(() => document.getElementById('btn-loop').click()); // stop rec
await sleep(300);
await pressClear(page);
await sleep(300);

// --- Scenario 8: hold a note across the loop boundary while recording ---
await pickInstrument(page, 'organ');
await page.evaluate(() => document.getElementById('btn-loop').click());
await sleep(200);
await page.evaluate(firePointer, 'pointerdown', 1, 0.5, 0.5);
// Loop is 2 bars at ~120bpm ≈ 4s — hold past the wrap point.
await sleep(4600);
await page.evaluate(firePointer, 'pointerup', 1, 0.5, 0.5);
await sleep(2600);
record('hold across loop boundary (organ)', await checkStuck(page, 0));
await page.evaluate(() => document.getElementById('btn-loop').click()); // stop rec
await sleep(300);
await pressClear(page);
await sleep(300);

// --- Scenario 9: switch instrument while the finger is down, recording --
await pickInstrument(page, 'organ');
await page.evaluate(() => document.getElementById('btn-loop').click());
await sleep(200);
await page.evaluate(firePointer, 'pointerdown', 1, 0.5, 0.5);
await sleep(250);
await pickInstrument(page, 'pad');
await sleep(250);
await page.evaluate(firePointer, 'pointerup', 1, 0.5, 0.5);
await sleep(2600);
record('instrument flip mid-hold', await checkStuck(page, 0));
await page.evaluate(() => document.getElementById('btn-loop').click()); // stop rec
await sleep(300);
await pressClear(page);
await sleep(300);

// --- Scenario 10: transport stop right after a loop attack --------------
await pickInstrument(page, 'organ');
await page.evaluate(() => document.getElementById('btn-loop').click());
await sleep(200);
await page.evaluate(firePointer, 'pointerdown', 1, 0.35, 0.5);
await sleep(150);
await page.evaluate(firePointer, 'pointerup', 1, 0.35, 0.5);
await page.evaluate(() => document.getElementById('btn-loop').click());
await sleep(200);
for (let attempt = 0; attempt < 8; attempt += 1) {
  await sleep(300);
  await page.evaluate(() => document.getElementById('btn-transport').click()); // stop
  await sleep(80);
  await page.evaluate(() => document.getElementById('btn-transport').click()); // start
}
await sleep(200);
await page.evaluate(() => document.getElementById('btn-transport').click()); // final stop
record('transport stop/start race (organ)', await checkStuck(page, 600));

console.log('\nsummary:', report.filter((r) => r.stuck.length).length, 'of', report.length, 'scenarios stuck');
const diagnostics = await page.evaluate(() => ({
  missed: window.__missed.slice(-20),
  deferredCount: window.__deferred.length,
  deferredTail: window.__deferred.slice(-10),
}));
console.log('missed releases:', JSON.stringify(diagnostics.missed, null, 1));
console.log('deferred events:', diagnostics.deferredCount, JSON.stringify(diagnostics.deferredTail));
await browser.close();
