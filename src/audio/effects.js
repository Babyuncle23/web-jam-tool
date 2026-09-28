/**
 * Effects — HOST only.
 * Each effect is an independent module with a uniform interface, so the same
 * set can be instantiated twice: one chain for the drum machine, one for the
 * synth, each with its own parameters.
 */

class Effect {
  /** @type {string} */ id;
  /** @type {string} */ label;
  #tone;
  #node = null;
  #bypass;
  #input;
  #output;
  #enabled = false;
  #params = {};

  constructor(tone, { id, label, params }) {
    this.#tone = tone;
    this.id = id;
    this.label = label;
    this.#params = { ...params };
    this.#input = new tone.Gain(1);
    this.#output = new tone.Gain(1);
    this.#bypass = new tone.Gain(1);
    this.#input.connect(this.#bypass);
    this.#bypass.connect(this.#output);
  }

  get tone() {
    return this.#tone;
  }

  get node() {
    return this.#node;
  }

  get input() {
    return this.#input;
  }

  get output() {
    return this.#output;
  }

  get enabled() {
    return this.#enabled;
  }

  get params() {
    return { ...this.#params };
  }

  /** Subclasses build their Tone node here. */
  createNode() {
    throw new Error(`${this.id}: createNode() is not implemented`);
  }

  applyParam(_name, _value) {}

  setParam(name, value) {
    if (!(name in this.#params)) return undefined;
    this.#params[name] = value;
    if (this.#node) this.applyParam(name, value);
    return value;
  }

  setEnabled(enabled) {
    const next = Boolean(enabled);
    if (next === this.#enabled) return this.#enabled;
    this.#enabled = next;
    if (next) {
      if (!this.#node) {
        this.#node = this.createNode();
        for (const [name, value] of Object.entries(this.#params)) this.applyParam(name, value);
      }
      this.#input.disconnect(this.#bypass);
      this.#input.connect(this.#node);
      this.#node.connect(this.#output);
    } else {
      this.#input.disconnect(this.#node);
      this.#node.disconnect(this.#output);
      this.#input.connect(this.#bypass);
    }
    return this.#enabled;
  }

  dispose() {
    this.#node?.dispose();
    this.#input.dispose();
    this.#output.dispose();
    this.#bypass.dispose();
  }
}

export class DelayEffect extends Effect {
  constructor(tone) {
    super(tone, { id: 'delay', label: 'Delay', params: { time: 0.25, feedback: 0.35, wet: 0.35 } });
  }

  createNode() {
    const { time, feedback, wet } = this.params;
    return new this.tone.FeedbackDelay({ delayTime: time, feedback, wet });
  }

  applyParam(name, value) {
    if (name === 'time') this.node.delayTime.rampTo(value, 0.1);
    if (name === 'feedback') this.node.feedback.rampTo(value, 0.1);
    if (name === 'wet') this.node.wet.rampTo(value, 0.1);
  }
}

export class ReverbEffect extends Effect {
  constructor(tone) {
    super(tone, { id: 'reverb', label: 'Reverb', params: { decay: 2.4, wet: 0.3 } });
  }

  createNode() {
    const { decay, wet } = this.params;
    return new this.tone.Reverb({ decay, wet, preDelay: 0.02 });
  }

  applyParam(name, value) {
    if (name === 'decay') this.node.decay = value;
    if (name === 'wet') this.node.wet.rampTo(value, 0.1);
  }
}

export class DistortionEffect extends Effect {
  constructor(tone) {
    super(tone, { id: 'distortion', label: 'Distortion', params: { drive: 0.4, wet: 0.5 } });
  }

  createNode() {
    const { drive, wet } = this.params;
    return new this.tone.Distortion({ distortion: drive, wet, oversample: '2x' });
  }

  applyParam(name, value) {
    if (name === 'drive') this.node.distortion = value;
    if (name === 'wet') this.node.wet.rampTo(value, 0.1);
  }
}

/**
 * Reverse runs in an AudioWorklet: it records the live tail into a window
 * buffer and, when the window fills, plays that buffer backwards while the
 * next one records. The dry signal stays in parallel so `wet` is a real mix.
 * The processor source lives here (not in a stub node) and is registered once
 * per audio context.
 */
const REVERSE_PROCESSOR = `
class JamReverseProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.windowSamples = Math.max(128, Math.floor(sampleRate * 0.5));
    this.index = 0;
    this.record = [new Float32Array(this.windowSamples), new Float32Array(this.windowSamples)];
    this.play = [new Float32Array(this.windowSamples), new Float32Array(this.windowSamples)];
    this.pendingWindow = null;
    this.flushRequested = false;
    this.port.onmessage = (event) => {
      const data = event.data || {};
      if (data.type === 'window') this.pendingWindow = Number(data.seconds);
      if (data.type === 'flush') this.flushRequested = true;
    };
  }

  applyWindow(seconds) {
    const samples = Math.max(128, Math.min(Math.floor(sampleRate * 4), Math.floor(sampleRate * seconds)));
    if (!Number.isFinite(samples) || samples === this.windowSamples) return;
    this.windowSamples = samples;
    this.record = [new Float32Array(samples), new Float32Array(samples)];
    this.play = [new Float32Array(samples), new Float32Array(samples)];
    this.index = 0;
  }

  swap() {
    const recorded = this.record;
    this.record = this.play;
    this.play = recorded;
    this.record[0].fill(0);
    this.record[1].fill(0);
    this.index = 0;
  }

  ensureChannel(list, channel) {
    if (!list[channel] || list[channel].length !== this.windowSamples) {
      list[channel] = new Float32Array(this.windowSamples);
    }
    return list[channel];
  }

  process(inputs, outputs) {
    if (this.pendingWindow != null) {
      this.applyWindow(this.pendingWindow);
      this.pendingWindow = null;
    }
    if (this.flushRequested) {
      this.swap();
      this.flushRequested = false;
    }

    const input = inputs[0] || [];
    const output = outputs[0] || [];
    const frames = output[0] ? output[0].length : 0;
    const channels = output.length;
    for (let i = 0; i < frames; i += 1) {
      for (let channel = 0; channel < channels; channel += 1) {
        const source = input[channel] || input[0];
        const sample = source ? source[i] || 0 : 0;
        const record = this.ensureChannel(this.record, channel);
        const play = this.ensureChannel(this.play, channel);
        record[this.index] = sample;
        output[channel][i] = play[this.windowSamples - 1 - this.index] || 0;
      }
      this.index += 1;
      if (this.index >= this.windowSamples) this.swap();
    }
    return true;
  }
}
registerProcessor('jam-reverse', JamReverseProcessor);
`;

let reverseWorkletPromise = null;

/** Registers the reverse processor. Safe to call more than once. */
export function ensureReverseWorklet(tone) {
  if (globalThis.isSecureContext === false) {
    return Promise.reject(new Error('Reverse needs localhost or https'));
  }
  if (!reverseWorkletPromise) {
    const context = tone.getContext();
    const blob = new Blob([REVERSE_PROCESSOR], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    // Tone 15 wraps AudioContext (standardized-audio-context). The module has
    // to be added on that wrapper, or AudioWorkletNode rejects the context.
    const pending = context.addAudioWorkletModule
      ? context.addAudioWorkletModule(url)
      : context.rawContext.audioWorklet.addModule(url);
    reverseWorkletPromise = Promise.resolve(pending).finally(() => URL.revokeObjectURL(url));
    reverseWorkletPromise.catch(() => {
      reverseWorkletPromise = null;
    });
  }
  return reverseWorkletPromise;
}

let ReverseNodeClass = null;

function reverseNodeClass(tone) {
  if (ReverseNodeClass) return ReverseNodeClass;
  ReverseNodeClass = class ReverseNode extends tone.ToneAudioNode {
    constructor() {
      super();
      const context = tone.getContext();
      this.input = new tone.Gain(1);
      this.output = new tone.Gain(1);
      this._dry = new tone.Gain(1);
      this._wet = new tone.Gain(0);
      const options = {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      };
      this._worklet = context.createAudioWorkletNode
        ? context.createAudioWorkletNode('jam-reverse', options)
        : new AudioWorkletNode(context.rawContext, 'jam-reverse', options);

      this.input.output.connect(this._dry.input);
      this._dry.output.connect(this.output.input);
      // Tone.connect unwraps Gain nodes and accepts the worklet from the same wrapped context.
      tone.connect(this.input, this._worklet);
      tone.connect(this._worklet, this._wet);
      this._wet.output.connect(this.output.input);
    }

    setWet(value, seconds = 0.05) {
      const wet = Math.min(1, Math.max(0, Number(value) || 0));
      this._wet.gain.rampTo(wet, seconds);
      this._dry.gain.rampTo(1 - wet, seconds);
    }

    setWindow(seconds) {
      this._worklet.port.postMessage({ type: 'window', seconds: Number(seconds) || 0.5 });
    }

    /** Swap immediately: the tail captured so far starts playing backwards. */
    flush() {
      this._worklet.port.postMessage({ type: 'flush' });
    }

    dispose() {
      try {
        this._worklet.disconnect();
        this._worklet.port.close();
      } catch {
        // already torn down
      }
      this._dry.dispose();
      this._wet.dispose();
      return super.dispose();
    }
  };
  return ReverseNodeClass;
}

/**
 * Buffered reverse. While enabled, each window of audio is captured and then
 * played backwards. `captureAndReverse()` flushes the current tail early.
 */
export class ReverseEffect extends Effect {
  constructor(tone) {
    super(tone, { id: 'reverse', label: 'Reverse', params: { window: 0.5, wet: 0.55 } });
  }

  createNode() {
    const Node = reverseNodeClass(this.tone);
    const node = new Node();
    node.setWindow(this.params.window);
    node.setWet(this.params.wet, 0);
    return node;
  }

  applyParam(name, value) {
    if (!this.node) return;
    if (name === 'wet') this.node.setWet(value);
    if (name === 'window') this.node.setWindow(value);
  }

  captureAndReverse() {
    if (!this.enabled) this.setEnabled(true);
    this.node?.flush();
    return true;
  }
}

/** Dynamic filter driven by the Y axis of a guest touch pad. */
export class WahWahEffect extends Effect {
  #min = 180;
  #max = 4800;

  constructor(tone) {
    super(tone, { id: 'wah', label: 'Wah-Wah', params: { frequency: 900, q: 0.8, wet: 1 } });
  }

  createNode() {
    const { frequency, q } = this.params;
    return new this.tone.Filter({ type: 'bandpass', frequency, Q: q });
  }

  applyParam(name, value) {
    if (name === 'frequency') this.node.frequency.rampTo(value, 0.03);
    if (name === 'q') this.node.Q.rampTo(value, 0.05);
  }

  /** y ∈ [0,1] → exponential cutoff sweep, so the ear hears an even glide. */
  modulateFromY(y) {
    const clamped = Math.min(1, Math.max(0, y));
    const frequency = this.#min * Math.pow(this.#max / this.#min, clamped);
    // A sub-hertz nudge is inaudible and still costs an automation event.
    if (Math.abs(frequency - this.params.frequency) < 1) return this.params.frequency;
    this.setParam('frequency', frequency);
    return frequency;
  }

  /** Wide, high band so a chord is not stuck in the last single-note wah. */
  parkOpen() {
    this.setParam('q', 0.35);
    if (Math.abs(this.params.frequency - this.#max) < 1) return this.#max;
    this.setParam('frequency', this.#max);
    return this.#max;
  }
}

export const EFFECT_CLASSES = [DelayEffect, ReverbEffect, DistortionEffect, ReverseEffect, WahWahEffect];

/** Serial chain: input → wah → distortion → delay → reverse → reverb → output. */
export class EffectChain {
  #tone;
  #effects = new Map();
  #input;
  #output;

  constructor(engine, { name = 'chain', destination = engine.master } = {}) {
    this.#tone = engine.tone;
    this.name = name;
    this.#input = new this.#tone.Gain(1);
    this.#output = new this.#tone.Gain(1);

    let previous = this.#input;
    for (const EffectClass of EFFECT_CLASSES) {
      const effect = new EffectClass(this.#tone);
      previous.connect(effect.input);
      previous = effect.output;
      this.#effects.set(effect.id, effect);
    }
    previous.connect(this.#output);
    if (destination) this.#output.connect(destination);
  }

  get input() {
    return this.#input;
  }

  get output() {
    return this.#output;
  }

  get effects() {
    return [...this.#effects.values()];
  }

  get(id) {
    return this.#effects.get(id);
  }

  setEnabled(id, enabled) {
    return this.#effects.get(id)?.setEnabled(enabled);
  }

  setParam(id, name, value) {
    return this.#effects.get(id)?.setParam(name, value);
  }

  state() {
    return this.effects.map(({ id, label, enabled, params }) => ({ id, label, enabled, params }));
  }

  dispose() {
    for (const effect of this.#effects.values()) effect.dispose();
    this.#input.dispose();
    this.#output.dispose();
  }
}

/** Three effects per instrument. Level 0 is off, 1 is mild, 2 is strong. */
export const INSTRUMENT_FX = {
  pad: [
    { id: 'reverb', label: 'Rev' },
    { id: 'delay', label: 'Delay' },
    { id: 'chorus', label: 'Chor' },
  ],
  bass: [
    { id: 'drive', label: 'Dist' },
    { id: 'cutoff', label: 'Cut' },
    { id: 'slap', label: 'Slap' },
  ],
  organ: [
    { id: 'chorus', label: 'Chor' },
    { id: 'vibrato', label: 'Vib' },
    { id: 'room', label: 'Room' },
  ],
  kalimba: [
    { id: 'delay', label: 'Delay' },
    { id: 'reverb', label: 'Rev' },
    { id: 'reverse', label: 'Rvs' },
  ],
  synth: [
    { id: 'room', label: 'Room' },
    { id: 'delay', label: 'Delay' },
    { id: 'chorus', label: 'Chor' },
  ],
};

export const DRUM_FX = [
  { id: 'drive', label: 'Dist' },
  { id: 'cutoff', label: 'Cut' },
  { id: 'room', label: 'Room' },
];

export const FX_LEVELS = ['Off', 'Low', 'High'];

export function defaultFxState() {
  return {
    pad: { reverb: 0.5, delay: 0.5, chorus: 0.5 },
    bass: { drive: 0, cutoff: 0.62, slap: 0 },
    organ: { chorus: 0, vibrato: 0, room: 1 },
    kalimba: { delay: 0, reverb: 0.5, reverse: 0 },
    synth: { room: 0.5, delay: 0.5, chorus: 0 },
    drums: { drive: 0.5, cutoff: 0, room: 0.5 },
  };
}

/** Live instrument loudness, 0..1. Not stored in the loop. */
export function defaultLevels() {
  return { pad: 0.8, bass: 0.8, organ: 0.8, kalimba: 0.8, synth: 0.8 };
}

/**
 * Reverse without AudioWorklet. A ScriptProcessor only captures the tail.
 * Playback is a normal AudioBuffer, reversed, through a BufferSource.
 * Chrome allows this on http://LAN. The forward note is ducked, so what you
 * hear is the hit backwards, not a second copy of the delay.
 */
function nativeAudioContext(tone) {
  const raw = tone.getContext().rawContext;
  if (typeof raw?.createScriptProcessor === 'function' && typeof raw?.createBuffer === 'function') return raw;
  const native = raw?._nativeAudioContext;
  if (typeof native?.createScriptProcessor === 'function' && typeof native?.createBuffer === 'function') return native;
  throw new Error('Reverse needs AudioBuffer playback, and this context does not expose it');
}

function connectInto(sources, destination) {
  let lastError = null;
  for (const node of sources) {
    if (!node || typeof node.connect !== 'function') continue;
    try {
      node.connect(destination);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Reverse could not connect');
}

function createTailReverse(tone) {
  const input = new tone.Gain(1);
  const output = new tone.Gain(1);
  const dry = new tone.Gain(1);
  const wet = new tone.Gain(0);
  input.connect(dry);
  dry.connect(output);
  wet.connect(output);

  let processor = null;
  let sink = null;
  let raw = null;
  let mix = 0;
  const sources = new Set();

  function playReversed(samples) {
    const buffer = raw.createBuffer(1, samples.length, raw.sampleRate);
    const channel = buffer.getChannelData(0);
    const last = samples.length - 1;
    for (let i = 0; i < samples.length; i += 1) channel[i] = (samples[last - i] || 0) * 1.35;
    const fade = Math.min(128, samples.length >> 4);
    for (let i = 0; i < fade; i += 1) {
      const gain = i / fade;
      channel[i] *= gain;
      channel[last - i] *= gain;
    }
    const source = raw.createBufferSource();
    source.buffer = buffer;
    const amp = raw.createGain();
    amp.gain.value = Math.max(mix, 0.001);
    source.connect(amp);
    const outNode = output.output?._nativeAudioNode || output.input?._nativeAudioNode || output._nativeAudioNode;
    if (!outNode) throw new Error('Reverse output has no native node');
    amp.connect(outNode);
    source.onended = () => {
      sources.delete(source);
      try {
        source.disconnect();
        amp.disconnect();
      } catch {
        // already gone
      }
    };
    sources.add(source);
    source.start();
  }

  function ensureCapture() {
    if (processor) return;
    const contexts = [];
    try {
      contexts.push(nativeAudioContext(tone));
    } catch {
      // The wrapper context is tried below.
    }
    const wrapped = tone.getContext().rawContext;
    if (wrapped && !contexts.includes(wrapped)) contexts.push(wrapped);
    const taps = [input.output?._nativeAudioNode, input._nativeAudioNode, input.output, input].filter(Boolean);
    const errors = [];
    for (const context of contexts) {
      if (typeof context.createScriptProcessor !== 'function' || typeof context.createBuffer !== 'function') continue;
      for (const channels of [1, 2]) {
        let created = null;
        try {
          const length = Math.max(256, Math.floor(context.sampleRate * 0.46));
          const record = new Float32Array(length);
          let captured = 0;
          let quiet = 0;
          let tailQuiet = 0;
          let armed = false;
          const quietNeeded = Math.floor(context.sampleRate * 0.02);
          const minCapture = Math.floor(context.sampleRate * 0.12);
          const tailNeeded = Math.floor(context.sampleRate * 0.045);
          created = context.createScriptProcessor(2048, channels, 1);
          created.onaudioprocess = (event) => {
            const left = event.inputBuffer.getChannelData(0);
            const right = event.inputBuffer.numberOfChannels > 1 ? event.inputBuffer.getChannelData(1) : left;
            event.outputBuffer.getChannelData(0).fill(0);
            if (mix < 0.001) {
              armed = false;
              captured = 0;
              quiet = 0;
              tailQuiet = 0;
              return;
            }
            for (let i = 0; i < left.length; i += 1) {
              const sample = ((left[i] || 0) + (right[i] || 0)) * 0.5;
              const level = Math.abs(sample);
              if (!armed) {
                if (level < 0.02) quiet += 1;
                else if (quiet >= quietNeeded) {
                  armed = true;
                  captured = 0;
                  tailQuiet = 0;
                  record[captured] = sample;
                  captured += 1;
                  quiet = 0;
                }
                continue;
              }
              record[captured] = sample;
              captured += 1;
              if (level < 0.02) tailQuiet += 1;
              else tailQuiet = 0;
              const done = captured >= length || (captured >= minCapture && tailQuiet >= tailNeeded);
              if (!done) continue;
              const taken = captured;
              armed = false;
              captured = 0;
              tailQuiet = 0;
              quiet = 0;
              try {
                playReversed(record.slice(0, taken));
              } catch {
                // A bad playback connection must not stop the next hit.
              }
            }
          };
          let tapped = false;
          for (const tap of taps) {
            try {
              tap.connect(created);
              tapped = true;
              break;
            } catch (error) {
              errors.push(error?.message || String(error));
            }
          }
          if (!tapped) throw new Error('tail tap failed');
          const silent = context.createGain();
          silent.gain.value = 0;
          created.connect(silent);
          silent.connect(context.destination);
          raw = context;
          processor = created;
          sink = silent;
          return;
        } catch (error) {
          errors.push(error?.message || String(error));
          if (created) {
            created.onaudioprocess = null;
            try {
              created.disconnect();
            } catch {
              // not connected
            }
          }
        }
      }
    }
    throw new Error(errors.filter(Boolean).join(' | ') || 'reverse capture failed');
  }

  return {
    input,
    output,
    setWet(amount) {
      const next = clampFx(amount);
      if (next > 0.001 && !processor) {
        try {
          ensureCapture();
        } catch {
          dry.gain.rampTo(1, 0.03);
          wet.gain.rampTo(0, 0.03);
          mix = 0;
          return 0;
        }
      }
      mix = next;
      dry.gain.value = 1 - next;
      wet.gain.value = next;
      dry.gain.rampTo(1 - next, 0.03);
      wet.gain.rampTo(next, 0.03);
      return next;
    },
    dispose() {
      mix = 0;
      if (processor) {
        processor.onaudioprocess = null;
        try {
          processor.disconnect();
        } catch {
          // already disconnected
        }
      }
      try {
        sink?.disconnect();
      } catch {
        // already disconnected
      }
      for (const source of sources) {
        try {
          source.stop();
          source.disconnect();
        } catch {
          // already stopped
        }
      }
      sources.clear();
      wet.dispose();
      dry.dispose();
      input.dispose();
      output.dispose();
    },
  };
}

export function clampFx(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  if (number > 1) return 1;
  return number;
}

/** 0 is off, around 0.5 is mild, 1 is strong. Chips still speak those three words. */
export function fxAmountLabel(amount) {
  const value = clampFx(amount);
  if (value < 0.08) return 'Off';
  if (value > 0.75) return 'High';
  return 'Low';
}

export function cycleFxAmount(amount) {
  const value = clampFx(amount);
  if (value < 0.08) return 0.5;
  if (value < 0.75) return 1;
  return 0;
}

function blend(stops, amount) {
  const t = clampFx(amount);
  if (t <= 0.5) return stops[0] + ((stops[1] - stops[0]) * t) / 0.5;
  return stops[1] + ((stops[2] - stops[1]) * (t - 0.5)) / 0.5;
}

/**
 * How much of the dry level the wet path still carries.
 * Makeup is 1 / remaining level, so a wet mix stays about as loud as dry.
 * 8-bit is not in this table: it is left at unity.
 */
const WET_RETAIN = {
  delay: 0.48,
  reverb: 0.3,
  chorus: 0.66,
  drive: 0.58,
  slap: 0.5,
  room: 0.36,
  reverse: 0.45,
  vibrato: 0.74,
};

function makeupFromWets(parts) {
  let gain = 1;
  for (const [kind, wet] of Object.entries(parts)) {
    const retain = WET_RETAIN[kind] ?? 0.6;
    const mixed = 1 - clampFx(wet) * (1 - retain);
    gain *= 1 / Math.max(0.32, mixed);
  }
  return Math.min(3.6, gain);
}

export const FX_COLORS = {
  reverb: '#3d8fd4',
  delay: '#e07a3d',
  chorus: '#6aaa3a',
  drive: '#d23c3c',
  cutoff: '#6b7c3a',
  slap: '#e2b43a',
  vibrato: '#c45b9a',
  room: '#c4a574',
  tone: '#8d6b4a',
  reverse: '#2f8f8a',
};

/**
 * One private effect rig per instrument, built once. Nothing here is shared
 * with the drum machine or constructed per touch.
 */
export function createInstrumentBus(tone) {
  const mix = new tone.Gain(1);
  const nodes = [];
  const voiceGains = {};
  const keep = (node) => {
    nodes.push(node);
    return node;
  };
  const finish = (instrument, node, { darken = false } = {}) => {
    let last = node;
    if (darken) {
      const shelf = keep(new tone.Filter({ type: 'highshelf', frequency: 2200, gain: -8, Q: 0.7 }));
      last.connect(shelf);
      last = shelf;
    }
    const audible = keep(new tone.Gain(1));
    voiceGains[instrument] = audible;
    last.connect(audible);
    audible.connect(mix);
  };
  const chain = (instrument, input, ...rest) => {
    let previous = input;
    for (const node of rest) {
      previous.connect(node);
      previous = node;
    }
    finish(instrument, previous, { darken: instrument !== 'bass' });
  };

  const wetNow = {
    pad: { delay: 0, reverb: 0, chorus: 0 },
    bass: { drive: 0, slap: 0 },
    organ: { chorus: 0, vibrato: 0, room: 0 },
    kalimba: { delay: 0, reverb: 0, reverse: 0 },
    synth: { delay: 0, room: 0, chorus: 0 },
  };
  const makeup = {};
  const punch = (instrument) => {
    makeup[instrument]?.gain.rampTo(makeupFromWets(wetNow[instrument]), 0.05);
  };
  const makeUp = (instrument) => {
    const gain = keep(new tone.Gain(1));
    makeup[instrument] = gain;
    return gain;
  };

  const padIn = keep(new tone.Gain(1));
  const padDelay = keep(new tone.FeedbackDelay({ delayTime: '8n', feedback: 0.28, wet: 0 }));
  const padReverb = keep(new tone.Reverb({ decay: 5.5, wet: 0, preDelay: 0.02 }));
  const padChorus = keep(new tone.Chorus({ frequency: 0.35, delayTime: 3.2, depth: 0.45, wet: 0 }));
  if (typeof padChorus.start === 'function') padChorus.start();
  chain('pad', padIn, padDelay, padReverb, padChorus, makeUp('pad'));

  const bassIn = keep(new tone.Gain(1));
  const bassDrive = keep(new tone.Distortion({ distortion: 0.4, wet: 0, oversample: '2x' }));
  const bassFilter = keep(new tone.Filter({ type: 'lowpass', frequency: 750, Q: 0.5, rolloff: -24 }));
  const bassSlap = keep(new tone.FeedbackDelay({ delayTime: '16n', feedback: 0.18, wet: 0 }));
  chain('bass', bassIn, bassDrive, bassFilter, bassSlap, makeUp('bass'));

  const organIn = keep(new tone.Gain(1));
  const organChorus = keep(new tone.Chorus({ frequency: 1.6, delayTime: 3.4, depth: 0.65, wet: 0 }));
  if (typeof organChorus.start === 'function') organChorus.start();
  const organVibrato = keep(new tone.Vibrato({ frequency: 5.2, depth: 0.18, wet: 0 }));
  const organRoom = keep(new tone.Reverb({ decay: 1.6, wet: 0, preDelay: 0.01 }));
  chain('organ', organIn, organChorus, organVibrato, organRoom, makeUp('organ'));

  const kalimbaIn = keep(new tone.Gain(1));
  const kalimbaDelay = keep(new tone.FeedbackDelay({ delayTime: 0.16, feedback: 0.22, wet: 0 }));
  const kalimbaReverb = keep(new tone.Reverb({ decay: 1.8, wet: 0, preDelay: 0.01 }));
  const kalimbaReverse = createTailReverse(tone);
  nodes.push(kalimbaReverse);
  const kalimbaMakeup = makeUp('kalimba');
  kalimbaIn.connect(kalimbaDelay);
  kalimbaDelay.connect(kalimbaReverb);
  kalimbaReverb.connect(kalimbaReverse.input);
  kalimbaReverse.output.connect(kalimbaMakeup);
  finish('kalimba', kalimbaMakeup, { darken: true });

  const synthIn = keep(new tone.Gain(1));
  const synthDelay = keep(new tone.FeedbackDelay({ delayTime: '8n', feedback: 0.2, wet: 0 }));
  const synthRoom = keep(new tone.Reverb({ decay: 2.2, wet: 0, preDelay: 0.012 }));
  const synthChorus = keep(new tone.Chorus({ frequency: 1.8, delayTime: 3.5, depth: 0.7, wet: 0 }));
  if (typeof synthChorus.start === 'function') synthChorus.start();
  chain('synth', synthIn, synthDelay, synthRoom, synthChorus, makeUp('synth'));

  const apply = {
    pad: {
      reverb: (amount) => {
        const wet = blend([0, 0.34, 0.62], amount);
        wetNow.pad.reverb = wet;
        padReverb.wet.rampTo(wet, 0.06);
        punch('pad');
      },
      delay: (amount) => {
        const wet = blend([0, 0.22, 0.46], amount);
        wetNow.pad.delay = wet;
        padDelay.wet.rampTo(wet, 0.06);
        punch('pad');
      },
      chorus: (amount) => {
        const wet = blend([0, 0.28, 0.55], amount);
        wetNow.pad.chorus = wet;
        padChorus.wet.rampTo(wet, 0.06);
        punch('pad');
      },
    },
    bass: {
      drive: (amount) => {
        bassDrive.distortion = blend([0, 0.4, 0.72], amount);
        const wet = blend([0, 0.5, 0.82], amount);
        wetNow.bass.drive = wet;
        bassDrive.wet.rampTo(wet, 0.05);
        punch('bass');
      },
      cutoff: (amount) => bassFilter.frequency.rampTo(blend([8000, 900, 280], amount), 0.05),
      slap: (amount) => {
        const wet = blend([0, 0.18, 0.4], amount);
        wetNow.bass.slap = wet;
        bassSlap.wet.rampTo(wet, 0.05);
        punch('bass');
      },
    },
    organ: {
      chorus: (amount) => {
        const wet = blend([0, 0.4, 0.7], amount);
        wetNow.organ.chorus = wet;
        organChorus.wet.rampTo(wet, 0.06);
        punch('organ');
      },
      vibrato: (amount) => {
        const wet = blend([0, 0.28, 0.55], amount);
        wetNow.organ.vibrato = wet;
        organVibrato.wet.rampTo(wet, 0.06);
        punch('organ');
      },
      room: (amount) => {
        const wet = blend([0, 0.2, 0.42], amount);
        wetNow.organ.room = wet;
        organRoom.wet.rampTo(wet, 0.06);
        punch('organ');
      },
    },
    kalimba: {
      delay: (amount) => {
        const wet = blend([0, 0.28, 0.5], amount);
        wetNow.kalimba.delay = wet;
        kalimbaDelay.wet.rampTo(wet, 0.05);
        punch('kalimba');
      },
      reverb: (amount) => {
        const wet = blend([0, 0.18, 0.4], amount);
        wetNow.kalimba.reverb = wet;
        kalimbaReverb.wet.rampTo(wet, 0.05);
        punch('kalimba');
      },
      reverse: (amount) => {
        const wet = kalimbaReverse.setWet(amount);
        wetNow.kalimba.reverse = wet;
        punch('kalimba');
      },
    },
    synth: {
      room: (amount) => {
        const wet = blend([0, 0.28, 0.5], amount);
        wetNow.synth.room = wet;
        synthRoom.wet.rampTo(wet, 0.06);
        punch('synth');
      },
      delay: (amount) => {
        const wet = blend([0, 0.16, 0.36], amount);
        wetNow.synth.delay = wet;
        synthDelay.wet.rampTo(wet, 0.06);
        punch('synth');
      },
      chorus: (amount) => {
        const depth = blend([0.15, 0.55, 0.9], amount);
        if (typeof synthChorus.depth?.rampTo === 'function') synthChorus.depth.rampTo(depth, 0.06);
        else synthChorus.depth = depth;
        synthChorus.frequency.rampTo(blend([0.3, 1.6, 3.2], amount), 0.06);
        const wet = blend([0, 0.5, 0.85], amount);
        wetNow.synth.chorus = wet;
        synthChorus.wet.rampTo(wet, 0.06);
        punch('synth');
      },
    },
  };

  const inputs = { pad: padIn, bass: bassIn, organ: organIn, kalimba: kalimbaIn, synth: synthIn };
  const readiness = [padReverb, organRoom, kalimbaReverb, synthRoom].map((reverb) => reverb.ready ?? Promise.resolve());

  return {
    mix,
    inputs,
    ready: Promise.all(readiness),
    setEffect(instrument, id, value) {
      const amount = clampFx(value);
      apply[instrument]?.[id]?.(amount);
      return amount;
    },
    setLevel(instrument, value) {
      const amount = clampFx(value);
      inputs[instrument]?.gain.rampTo(amount, 0.04);
      return amount;
    },
    setAudible(instrument, audible) {
      voiceGains[instrument]?.gain.rampTo(audible ? 1 : 0, 0.03);
    },
    dispose() {
      for (const node of nodes) node.dispose?.();
      mix.dispose();
    },
  };
}

/** Drum-only distortion, cutoff and a small room. Not wired to the synth. */
export function createDrumBus(tone) {
  const input = new tone.Gain(1);
  const output = new tone.Gain(1);
  const audible = new tone.Gain(1);
  const makeup = new tone.Gain(1);
  const drive = new tone.Distortion({ distortion: 0.35, wet: 0, oversample: '2x' });
  const filter = new tone.Filter({ type: 'lowpass', frequency: 14000, Q: 0.5, rolloff: -12 });
  const room = new tone.Reverb({ decay: 0.9, wet: 0, preDelay: 0 });
  const wetNow = { drive: 0, room: 0 };
  const punch = () => makeup.gain.rampTo(makeupFromWets(wetNow), 0.05);
  input.connect(drive);
  drive.connect(filter);
  filter.connect(room);
  room.connect(makeup);
  makeup.connect(audible);
  audible.connect(output);
  const apply = {
    drive: (amount) => {
      drive.distortion = blend([0, 0.35, 0.7], amount);
      const wet = blend([0, 0.4, 0.75], amount);
      wetNow.drive = wet;
      drive.wet.rampTo(wet, 0.05);
      punch();
    },
    cutoff: (amount) => filter.frequency.rampTo(blend([14000, 4200, 900], amount), 0.05),
    room: (amount) => {
      const wet = blend([0, 0.16, 0.34], amount);
      wetNow.room = wet;
      room.wet.rampTo(wet, 0.05);
      punch();
    },
  };
  return {
    input,
    output,
    ready: room.ready ?? Promise.resolve(),
    setEffect(id, value) {
      const amount = clampFx(value);
      apply[id]?.(amount);
      return amount;
    },
    setAudible(heard) {
      audible.gain.rampTo(heard ? 1 : 0, 0.03);
    },
    dispose() {
      drive.dispose();
      filter.dispose();
      room.dispose();
      makeup.dispose();
      audible.dispose();
      input.dispose();
      output.dispose();
    },
  };
}

const REPEAT_BEATS = { '4n': 1, '8n': 0.5, '16n': 0.25, '32n': 0.125 };
/** Stutter divisions, coarse → dense. The FX pad maps these to X zones. */
export const REPEAT_ORDER = ['4n', '8n', '16n', '32n'];
/** FX pad X zones, left → right: a filter-only lane, then the stutter divisions. */
export const FX_PAD_DIVISIONS = [null, ...REPEAT_ORDER];
const CUTOFF_OPEN_HZ = 14000;
const CUTOFF_DARK_HZ = 180;
const HIPASS_OPEN_HZ = 24;
const HIPASS_THIN_HZ = 4000;
/** Narrow bandpass makeup. 8-bit is not lifted. Was 2.8; 4.8 sits closer to the dry bus. */
const WAH_LIFT = 4.8;

/** Lowpass frequency for a master cutoff amount. Amount 0 bypasses the filter instead. */
export function masterCutoffHz(amount) {
  const value = clampFx(amount);
  return CUTOFF_OPEN_HZ * Math.pow(CUTOFF_DARK_HZ / CUTOFF_OPEN_HZ, value);
}

/** Highpass frequency for a master hipass amount. Amount 0 bypasses the filter instead. */
export function masterHipassHz(amount) {
  const value = clampFx(amount);
  return HIPASS_OPEN_HZ * Math.pow(HIPASS_THIN_HZ / HIPASS_OPEN_HZ, value);
}

/**
 * Master inserts after the instrument mix and before the limiter.
 * Signal order: beat-repeat stutter, then the cutoff stage, then 8-bit, then wah.
 * The repeat is not part of a loop. The slice is a delay line, not a frame loop
 * and not an AudioWorklet. Hold replaces the live bus at full level.
 * The cutoff stage is bipolar: lowpass (cut highs) and highpass (cut lows)
 * share one dry/wet gate and are never wet at once — the FX pad picks one by
 * which side of the Y middle the finger sits on. Both at 0 is a true bypass.
 * 8-bit stays at unity. Wah gets makeup because the bandpass would otherwise
 * duck the bus.
 */
export function createMasterFx(tone, bpm = 96) {
  const input = new tone.Gain(1);
  const output = new tone.Gain(1);
  const live = new tone.Gain(1);
  const grab = new tone.Gain(0);
  const repeat = new tone.Gain(0);
  const post = new tone.Gain(1);

  const cutDry = new tone.Gain(1);
  const cutWet = new tone.Gain(0);
  const cutoff = new tone.Filter({ type: 'lowpass', frequency: CUTOFF_OPEN_HZ, Q: 0.7, rolloff: -24 });
  const hpWet = new tone.Gain(0);
  const hipass = new tone.Filter({ type: 'highpass', frequency: HIPASS_OPEN_HZ, Q: 0.7, rolloff: -24 });
  let cutAmount = 0;
  let hpAmount = 0;
  const crushDry = new tone.Gain(1);
  const crushWet = new tone.Gain(0);
  const crusher = new tone.WaveShaper((value) => value, 2048);
  const wahDry = new tone.Gain(1);
  const wahWet = new tone.Gain(0);
  const wahLift = new tone.Gain(1);
  const wah = new tone.Filter({ type: 'bandpass', frequency: 800, Q: 5, rolloff: -12 });

  input.connect(live);
  input.connect(grab);
  live.connect(post);
  repeat.connect(post);
  post.connect(cutDry);
  post.connect(cutoff);
  cutoff.connect(cutWet);
  post.connect(hipass);
  hipass.connect(hpWet);
  cutDry.connect(crushDry);
  cutWet.connect(crushDry);
  hpWet.connect(crushDry);
  cutDry.connect(crusher);
  cutWet.connect(crusher);
  crusher.connect(crushWet);
  crushDry.connect(wahDry);
  crushWet.connect(wahDry);
  crushDry.connect(wah);
  crushWet.connect(wah);
  wah.connect(wahLift);
  wahLift.connect(wahWet);
  wahDry.connect(output);
  wahWet.connect(output);

  let tempo = bpm;
  let division = '16n';
  let held = false;
  let captureEnd = 0;
  let delay = null;

  const sliceLength = () => {
    const beats = REPEAT_BEATS[division] ?? 0.25;
    return Math.min(1.9, Math.max(0.03, (60 / tempo) * beats));
  };

  const dropDelay = () => {
    if (!delay) return;
    try {
      grab.disconnect(delay);
    } catch {
      // The grab was already detached.
    }
    try {
      delay.disconnect(repeat);
    } catch {
      // The delay was already detached.
    }
    delay.dispose();
    delay = null;
  };

  const scheduleMix = (now) => {
    live.gain.cancelScheduledValues(now);
    repeat.gain.cancelScheduledValues(now);
    if (!held) {
      live.gain.setValueAtTime(1, now);
      repeat.gain.setValueAtTime(0, now);
      return;
    }
    if (captureEnd > now + 0.0005) {
      live.gain.setValueAtTime(1, now);
      repeat.gain.setValueAtTime(0, now);
      live.gain.setValueAtTime(1, captureEnd);
      live.gain.linearRampToValueAtTime(0, captureEnd + 0.012);
      repeat.gain.setValueAtTime(0, captureEnd);
      repeat.gain.linearRampToValueAtTime(1, captureEnd + 0.012);
      return;
    }
    live.gain.setValueAtTime(0, now);
    repeat.gain.setValueAtTime(1, now);
  };

  const capture = () => {
    const now = tone.now();
    const length = sliceLength();
    const fade = Math.min(0.004, length * 0.12);
    try {
      held = true;
      captureEnd = now + length;
      dropDelay();
      delay = new tone.FeedbackDelay({
        delayTime: length,
        maxDelay: 2,
        feedback: 0,
        wet: 1,
      });
      grab.connect(delay);
      delay.connect(repeat);
      delay.delayTime.cancelScheduledValues(now);
      delay.delayTime.setValueAtTime(length, now);
      if (delay.wet?.setValueAtTime) delay.wet.setValueAtTime(1, now);
      else delay.wet.value = 1;
      delay.feedback.cancelScheduledValues(now);
      delay.feedback.setValueAtTime(0, now);
      delay.feedback.setValueAtTime(1, now + length);
      grab.gain.cancelScheduledValues(now);
      grab.gain.setValueAtTime(1, now);
      grab.gain.setValueAtTime(1, now + Math.max(0, length - fade));
      grab.gain.linearRampToValueAtTime(0, now + length);
      scheduleMix(now);
    } catch (error) {
      console.error(error);
      release();
    }
  };

  const release = () => {
    const now = tone.now();
    held = false;
    grab.gain.cancelScheduledValues(now);
    grab.gain.setValueAtTime(0, now);
    if (delay) {
      delay.feedback.cancelScheduledValues(now);
      delay.feedback.setValueAtTime(0, now);
    }
    live.gain.cancelScheduledValues(now);
    repeat.gain.cancelScheduledValues(now);
    live.gain.setValueAtTime(live.gain.value, now);
    repeat.gain.setValueAtTime(repeat.gain.value, now);
    live.gain.linearRampToValueAtTime(1, now + 0.01);
    repeat.gain.linearRampToValueAtTime(0, now + 0.01);
  };

  return {
    input,
    output,
    setBpm(next) {
      tempo = Math.min(200, Math.max(40, Number(next) || tempo));
      if (held) capture();
    },
    setDivision(next) {
      const name = REPEAT_ORDER.includes(next) ? next : REPEAT_ORDER[Math.round(Number(next))] || '16n';
      division = REPEAT_ORDER.includes(name) ? name : '16n';
      if (held) capture();
      return division;
    },
    /** Hold captures the slice that is sounding now and loops it at full level until release. */
    setHold(next) {
      if (next && !held) capture();
      else if (!next && held) release();
      return held;
    },
    holding() {
      return held;
    },
    sliceSeconds() {
      return sliceLength();
    },
    liveGain() {
      return live.gain.value;
    },
    repeatGain() {
      return repeat.gain.value;
    },
    /** 0 bypasses the lowpass. Higher amounts close it from bright to dark. */
    setCutoff(amount) {
      const value = clampFx(amount);
      cutAmount = value;
      if (value < 0.001) {
        cutWet.gain.value = 0;
        cutDry.gain.value = hpAmount > 0 ? 0 : 1;
        return 0;
      }
      cutoff.frequency.rampTo(masterCutoffHz(value), 0.03);
      cutWet.gain.value = 1;
      cutDry.gain.value = 0;
      return value;
    },
    /** 0 bypasses the highpass. Higher amounts thin the lows out. */
    setHipass(amount) {
      const value = clampFx(amount);
      hpAmount = value;
      if (value < 0.001) {
        hpWet.gain.value = 0;
        cutDry.gain.value = cutAmount > 0 ? 0 : 1;
        return 0;
      }
      hipass.frequency.rampTo(masterHipassHz(value), 0.03);
      hpWet.gain.value = 1;
      cutDry.gain.value = 0;
      return value;
    },
    setCrush(amount) {
      const grit = clampFx(amount);
      const bits = grit < 0.001 ? 16 : Math.round(12 - grit * 9);
      const steps = 2 ** bits;
      const length = 2048;
      const curve = new Float32Array(length);
      for (let i = 0; i < length; i += 1) {
        const x = (i / (length - 1)) * 2 - 1;
        curve[i] = Math.round(x * steps) / steps;
      }
      crusher.curve = curve;
      crushWet.gain.value = grit < 0.001 ? 0 : 1;
      crushDry.gain.value = grit < 0.001 ? 1 : 0;
      return grit;
    },
    setWah(amount) {
      const value = clampFx(amount);
      if (value < 0.001) {
        wahWet.gain.value = 0;
        wahDry.gain.value = 1;
        wahLift.gain.value = 1;
        return 0;
      }
      wah.frequency.value = 160 * Math.pow(2400 / 160, value);
      wahLift.gain.value = WAH_LIFT;
      wahWet.gain.value = 1;
      wahDry.gain.value = 0;
      return value;
    },
    dispose() {
      release();
      dropDelay();
      for (const node of [input, output, live, grab, repeat, post, cutDry, cutWet, cutoff, hpWet, hipass, crushDry, crushWet, crusher, wahDry, wahWet, wahLift, wah]) {
        node.dispose?.();
      }
    },
  };
}
