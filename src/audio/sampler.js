/**
 * Pad sampler — HOST audio side (Tone.js never loads on guests).
 *
 * Every sound pad has a hard-coded mode:
 *   'oneshot' — plays the buffer to its end; a re-trigger chokes that pad's
 *               own previous voice. Pads never cut each other.
 *   'gate'    — plays while held; release() fades it out. `spec.release`
 *               (seconds) overrides the default 60 ms fade-out tail.
 *
 * A pad may carry `bpm` — the source tempo stamped on the file. For those
 * pads `stretch` is LOCKED to the session tempo (`stretch = spec.bpm /
 * sessionBpm`, so a 105 bpm scratch plays faster at 120) and follows BPM
 * changes live. Edit gestures on them move pitch only — there is no manual
 * stretch on tempo-locked pads.
 *
 * Per-pad tuning uses two independent axes of the GrainPlayer:
 *   `stretch` is a DURATION multiplier (×2 = twice as long, slower) — the
 *   GrainPlayer rate is speed, so it gets 1/stretch;
 *   `detune` shifts pitch without changing length.
 * Guests only send {sampleHit}/{sampleSolo}/{sampleTune} controls — all the
 * nodes below live on the host.
 *
 * Sources (meme sounds are user-provided downloads, documented in README):
 *   scratch-105.mp3 — "Scratch 105 bpm" by freesound_community, Pixabay Content License.
 *   okay-lets-go.mp3 — "Okay, let's go" ride-operator kid, Man bijt hond (TROS, NL), viral 2020+.
 *   vine-boom.mp3 — Vine app's stock dramatic bass hit, ~2014.
 *   anime-wow.mp3 — "Wow!" voice from Konami's Parodius! (1990), stock anime SFX.
 *   why-are-you-running.mp3 — "Why are you running?" from Nollywood's Pretty Liars 1 (2014).
 *   omg-hell-nah.mp3 — "Oh my god bro, oh hell nah man" TikTok reaction (osofaneto, ~2019).
 *   im-stronger.mp3 — "I'm stronger, I'm smarter" viral gym/motivation meme audio.
 */

export const SAMPLE_BANK = [
  // gain — extra trim on top of the peak normalization: bruh sits lower.
  { id: 'brah', label: 'BRUH', src: './samples/bruh.mp3', mode: 'oneshot', gain: 0.6 },
  { id: 'fah', label: 'FAH', src: './samples/fah.mp3', mode: 'oneshot', gain: 0.8 },
  { id: 'scratch105', label: 'SCR 105', src: './samples/scratch-105.mp3', mode: 'gate', bpm: 105 },
  { id: 'okayletsgo', label: 'LETS GO', src: './samples/okay-lets-go.mp3', mode: 'oneshot' },
  { id: 'vineboom', label: 'BOOM', src: './samples/vine-boom.mp3', mode: 'oneshot' },
  { id: 'animewow', label: 'WOW', src: './samples/anime-wow.mp3', mode: 'gate', release: 0.3 },
  { id: 'whyrun', label: 'WHY RUN', src: './samples/why-are-you-running.mp3', mode: 'gate' },
  { id: 'omg', label: 'OMG', src: './samples/omg-hell-nah.mp3', mode: 'gate' },
  { id: 'stronger', label: 'STRONG', src: './samples/im-stronger.mp3', mode: 'gate' },
];

export const SOLO_ACTION = 'solo';

/**
 * The 4×3 pad grid, row-major top → bottom. Empty objects are reserved slots —
 * new sounds are hard-coded in by filling a cell. The action cell 'solo' holds
 * every other voice muted while a finger is on it.
 */
export const SAMPLER_PAD_CELLS = [
  { sample: 'okayletsgo' },
  { sample: 'vineboom' },
  { sample: 'animewow' },
  { sample: 'whyrun' },
  { sample: 'scratch105' },
  { sample: 'omg' },
  { sample: 'stronger' },
  {},
  { sample: 'brah' },
  { sample: 'fah' },
  {},
  { action: SOLO_ACTION, label: 'SOLO' },
];

export const SAMPLE_PITCH_RANGE = 12;
export const SAMPLE_STRETCH_MIN = 0.5;
export const SAMPLE_STRETCH_MAX = 2;

export function clampSamplePitch(value) {
  return Math.max(-SAMPLE_PITCH_RANGE, Math.min(SAMPLE_PITCH_RANGE, Math.round(Number(value) || 0)));
}

export function clampSampleStretch(value) {
  return Math.max(SAMPLE_STRETCH_MIN, Math.min(SAMPLE_STRETCH_MAX, Number(value) || 1));
}

/** Initial per-sample tuning, one entry per bank row. */
export function defaultSampleParams() {
  return Object.fromEntries(SAMPLE_BANK.map((spec) => [spec.id, { pitch: 0, stretch: 1 }]));
}

export function sampleLabel(id) {
  return SAMPLE_BANK.find((spec) => spec.id === id)?.label || String(id || '').toUpperCase();
}

export function sampleMode(id) {
  return SAMPLE_BANK.find((spec) => spec.id === id)?.mode || 'oneshot';
}

/** Source tempo of a tempo-locked pad, or 0 for free-stretch pads. */
export function sampleBpm(id) {
  return SAMPLE_BANK.find((spec) => spec.id === id)?.bpm || 0;
}

const VOICES_PER_PAD = 3;
const LOAD_TIMEOUT_MS = 5000;
const CHOKE_SECONDS = 0.014;
const GATE_RELEASE_SECONDS = 0.06;
/** ~-38 dBFS: above encoder noise, below any real transient. */
const SILENCE_FLOOR = 0.012;
const ONSET_BACKOFF_S = 0.005;
/**
 * Samples pitched down push their spectrum under the bass — the cut rises
 * gently so -12 st still leaves the kick region clear.
 */
const BASS_GUARD_HZ = 120;

function guardHz(pitch) {
  return BASS_GUARD_HZ * Math.pow(2, Math.max(0, -(pitch || 0)) / 24);
}

/** First sample above the noise floor → seconds, with a tiny pre-onset backoff. */
function onsetSeconds(buffer) {
  const audio = buffer?.get?.() ?? buffer;
  if (!audio?.length) return 0;
  let first = Infinity;
  for (let ch = 0; ch < audio.numberOfChannels; ch += 1) {
    const data = audio.getChannelData(ch);
    for (let i = 0; i < data.length; i += 1) {
      if (Math.abs(data[i]) > SILENCE_FLOOR) {
        first = Math.min(first, i);
        break;
      }
    }
  }
  if (!Number.isFinite(first) || first === 0) return 0;
  return Math.max(0, first / audio.sampleRate - ONSET_BACKOFF_S);
}

/**
 * Source loudness varies wildly between downloads — normalize every pad to a
 * common peak so no pad sounds flat or clipped next to the others.
 * `spec.gain` is an optional extra trim on top.
 */
const TARGET_PEAK = 0.62;
const NORM_MIN = 0.25;
const NORM_MAX = 4;

function peakAmplitude(buffer) {
  const audio = buffer?.get?.() ?? buffer;
  if (!audio?.length) return 0;
  let peak = 0;
  for (let ch = 0; ch < audio.numberOfChannels; ch += 1) {
    const data = audio.getChannelData(ch);
    for (let i = 0; i < data.length; i += 1) {
      const level = Math.abs(data[i]);
      if (level > peak) peak = level;
    }
  }
  return peak;
}

/** Param objects (GrainPlayer.playbackRate) and plain numbers both appear here. */
function setTarget(owner, key, value) {
  const target = owner[key];
  if (target && typeof target === 'object' && 'value' in target) target.value = value;
  else owner[key] = value;
}

export class PadSampler {
  #tone;
  #output;
  /** Session tempo — bpm-tagged pads stretch to it until hand-tuned. */
  #bpm = 96;
  /** sampleId → { spec, buffer, params, pool, cursor } */
  #pads = new Map();
  /** voiceId → { pad, slot } so loop/live voices can be cut by prefix. */
  #voices = new Map();
  /** Called with the sample id each time a pad actually sounds. */
  onFire = null;
  /** Called (sampleId, sounding) when a gate pad starts or stops sounding —
   *  loop playback included, so the UI can keep the pad lit for the ride. */
  onVoice = null;
  ready;

  constructor(engine, { params = {} } = {}) {
    this.#tone = engine.tone;
    this.#output = new this.#tone.Gain(1);
    for (const spec of SAMPLE_BANK) {
      this.#pads.set(spec.id, {
        spec,
        // High-pass per pad keeps the sampler from masking the bass; pitching
        // down lifts the cut a little (see guardHz).
        filter: new this.#tone.Filter(guardHz(clampSamplePitch(params[spec.id]?.pitch)), 'highpass').connect(this.#output),
        offset: 0,
        params: {
          pitch: clampSamplePitch(params[spec.id]?.pitch),
          stretch: clampSampleStretch(params[spec.id]?.stretch),
        },
        /** Peak-normalized level for the pad's voices (set after load). */
        vol: 1,
        /** Last emitted gate-sounding state — onVoice dedupes on it. */
        voiceOn: false,
        pool: [],
        cursor: 0,
      });
    }
    // Tempo-locked pads start already fitted to the session tempo.
    for (const pad of this.#pads.values()) {
      if (pad.spec.bpm) pad.params.stretch = this.#autoStretch(pad);
    }
    this.ready = this.#load();
  }

  /** The node the sampler feeds — wired straight to the master gain. */
  get output() {
    return this.#output;
  }

  /**
   * Mixer gate — a soloed instrument voice silences the sampler too (the
   * sampler has no own solo/mute flag; the pad's held SOLO is the opposite:
   * it mutes everything else, not this bus).
   */
  setAudible(on) {
    this.#output.gain.setTargetAtTime(on ? 1 : 0, this.#tone.now(), 0.02);
  }

  paramsOf(id) {
    const params = this.#pads.get(id)?.params;
    return params ? { ...params } : null;
  }

  /** The stretch a bpm-tagged pad wants at the current session tempo. */
  #autoStretch(pad) {
    return pad.spec.bpm ? clampSampleStretch(pad.spec.bpm / this.#bpm) : 1;
  }

  /**
   * The session tempo changed: re-fit every bpm-tagged pad — their stretch
   * is locked to the tempo, edits cannot override it. Returns the ids whose
   * stretch moved, so the caller can repaint badges and push the new params
   * to guests.
   */
  setBpm(bpm) {
    const next = Math.min(200, Math.max(40, Number(bpm) || 96));
    if (next === this.#bpm) return [];
    this.#bpm = next;
    const changed = [];
    for (const [id, pad] of this.#pads) {
      if (!pad.spec.bpm) continue;
      const stretch = this.#autoStretch(pad);
      if (stretch === pad.params.stretch) continue;
      pad.params.stretch = stretch;
      changed.push(id);
      for (const slot of pad.pool) {
        if (slot.sounding) setTarget(slot.player, 'playbackRate', 1 / pad.params.stretch);
      }
    }
    return changed;
  }

  /**
   * Back to neutral: pitch 0 and — for bpm-tagged pads — the tempo-matched
   * stretch again. Non-bpm pads get ×1.
   */
  resetParams(id) {
    const pad = this.#pads.get(id);
    if (!pad) return null;
    pad.params.pitch = 0;
    pad.params.stretch = this.#autoStretch(pad);
    pad.filter.frequency.rampTo(guardHz(0), 0.05);
    for (const slot of pad.pool) {
      if (!slot.sounding) continue;
      setTarget(slot.player, 'detune', 0);
      setTarget(slot.player, 'playbackRate', 1 / pad.params.stretch);
    }
    return { ...pad.params };
  }

  async #load() {
    const tone = this.#tone;
    await Promise.all(
      [...this.#pads.values()].map(async (pad) => {
        try {
          const buffer = new tone.ToneAudioBuffer();
          await Promise.race([
            buffer.load(pad.spec.src),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), LOAD_TIMEOUT_MS)),
          ]);
          if (!buffer.loaded || !(buffer.duration > 0)) throw new Error('empty buffer');
          // Skip encoder delay and any leading hush baked into the file.
          pad.offset = onsetSeconds(buffer);
          const peak = peakAmplitude(buffer);
          if (peak > 0) {
            const norm = (TARGET_PEAK / peak) * (pad.spec.gain ?? 1);
            pad.vol = Math.max(NORM_MIN, Math.min(NORM_MAX, norm));
          }
          for (let i = 0; i < VOICES_PER_PAD; i += 1) {
            const gain = new tone.Gain(1).connect(pad.filter);
            const player = new tone.GrainPlayer({ grainSize: 0.16, overlap: 0.04, loop: false });
            player.buffer = buffer;
            player.connect(gain);
            const slot = { pad, player, gain, sounding: false, voiceId: null };
            player.onstop = () => {
              slot.sounding = false;
              if (slot.voiceId && this.#voices.get(slot.voiceId)?.slot === slot) {
                this.#voices.delete(slot.voiceId);
              }
              slot.voiceId = null;
              this.#emitVoice(slot.pad);
            };
            pad.pool.push(slot);
          }
        } catch {
          // A missing file leaves the pad silent instead of breaking the boot.
        }
      }),
    );
    return this;
  }

  get loaded() {
    return [...this.#pads.values()].some((pad) => pad.pool.length > 0);
  }

  /** Gate pads report their sounding state once per actual change. */
  #emitVoice(pad) {
    if (pad.spec.mode !== 'gate') return;
    const on = pad.pool.some((slot) => slot.sounding);
    if (on === pad.voiceOn) return;
    pad.voiceOn = on;
    this.onVoice?.(pad.spec.id, on);
  }

  /** Any slot making sound — probes check ring-out survives mode switches. */
  get sounding() {
    return [...this.#pads.values()].some((pad) => pad.pool.some((slot) => slot.sounding));
  }

  /** Retune one pad. A voice that is still sounding follows the new values. */
  setParams(id, { pitch, stretch } = {}) {
    const pad = this.#pads.get(id);
    if (!pad) return;
    if (pitch !== undefined) pad.params.pitch = clampSamplePitch(pitch);
    // Tempo-locked pads own their stretch — gestures cannot move it.
    if (stretch !== undefined && !pad.spec.bpm) {
      pad.params.stretch = clampSampleStretch(stretch);
    }
    pad.filter.frequency.rampTo(guardHz(pad.params.pitch), 0.05);
    for (const slot of pad.pool) {
      if (!slot.sounding) continue;
      setTarget(slot.player, 'detune', pad.params.pitch * 100);
      setTarget(slot.player, 'playbackRate', 1 / pad.params.stretch);
    }
  }

  /**
   * Fire a pad. One-shots choke only this pad's sounding voices — the fade is
   * on a per-slot Gain so the new voice (next pool slot) is never clipped.
   */
  trigger(id, { time, id: voiceId } = {}) {
    const pad = this.#pads.get(id);
    if (!pad?.pool.length) return false;
    const when = Math.max(0, Number.isFinite(time) ? time : this.#tone.now());
    for (const slot of pad.pool) {
      if (!slot.sounding) continue;
      slot.sounding = false;
      if (slot.voiceId) {
        this.#voices.delete(slot.voiceId);
        slot.voiceId = null;
      }
      // Fade instead of stop(): the source rings to the buffer's end in
      // silence, so a rapid re-trigger never races a pending stop event.
      const gain = slot.gain.gain;
      gain.cancelScheduledValues(when);
      gain.setValueAtTime(gain.value, when);
      gain.linearRampToValueAtTime(0, when + CHOKE_SECONDS);
    }
    const slot = pad.pool[pad.cursor % pad.pool.length];
    pad.cursor += 1;
    const gain = slot.gain.gain;
    gain.cancelScheduledValues(when);
    gain.setValueAtTime(pad.vol, when);
    setTarget(slot.player, 'detune', pad.params.pitch * 100);
    setTarget(slot.player, 'playbackRate', 1 / pad.params.stretch);
    try {
      // A release()/stopAll() stop scheduled in the slot's future would kill
      // the fresh start — pull any pending stop up to the trigger moment.
      slot.player.stop(when);
    } catch {
      // The slot was never started.
    }
    try {
      slot.player.start(when, pad.offset);
    } catch {
      return false;
    }
    slot.sounding = true;
    if (voiceId) {
      slot.voiceId = voiceId;
      this.#voices.set(voiceId, { pad: id, slot });
    }
    this.#emitVoice(pad);
    this.onFire?.(id);
    return true;
  }

  /** End a held ('gate') voice. One-shots are left to ring out. */
  release(voiceId, time) {
    const entry = this.#voices.get(voiceId);
    if (!entry) return;
    const pad = this.#pads.get(entry.pad);
    if (pad?.spec.mode !== 'gate') return;
    this.#stopSlot(entry.slot, time ?? this.#tone.now());
  }

  /**
   * A live finger lifted off a gate pad: cut its sounding slots — except any
   * that a recorded loop voice owns, those end on their own 'up' event.
   */
  releasePad(id, time) {
    const pad = this.#pads.get(id);
    if (pad?.spec.mode !== 'gate') return;
    const when = time ?? this.#tone.now();
    for (const slot of pad.pool) {
      if (slot.sounding && !String(slot.voiceId || '').startsWith('loop:')) {
        this.#stopSlot(slot, when);
      }
    }
  }

  #stopSlot(slot, time) {
    const when = Math.max(0, time);
    const release = slot.pad.spec.release ?? GATE_RELEASE_SECONDS;
    if (slot.sounding) {
      const gain = slot.gain.gain;
      gain.cancelScheduledValues(when);
      gain.setValueAtTime(gain.value, when);
      gain.linearRampToValueAtTime(0, when + release);
    }
    slot.sounding = false;
    if (slot.voiceId) {
      this.#voices.delete(slot.voiceId);
      slot.voiceId = null;
    }
    try {
      slot.player.stop(when + release);
    } catch {
      // Already idle.
    }
    this.#emitVoice(slot.pad);
  }

  /** Cut every voice whose id starts with `prefix` (e.g. `loop:peerId:`). */
  releaseMatching(prefix, time) {
    for (const [voiceId, entry] of this.#voices) {
      if (voiceId.startsWith(prefix)) this.#stopSlot(entry.slot, time ?? this.#tone.now());
    }
  }

  /** Hard stop for mode switches, park and dispose. */
  stopAll(time) {
    const when = Math.max(0, time ?? this.#tone.now());
    for (const pad of this.#pads.values()) {
      for (const slot of pad.pool) this.#stopSlot(slot, when);
    }
    this.#voices.clear();
  }

  dispose() {
    this.stopAll();
    for (const pad of this.#pads.values()) {
      for (const slot of pad.pool) {
        slot.player.dispose();
        slot.gain.dispose();
      }
      pad.pool = [];
      pad.filter.dispose();
    }
    this.#output.dispose();
  }
}
