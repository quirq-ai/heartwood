// A small generative composer for the Web Audio API: three moods sharing one set of
// instruments (heartbeat kick, sub bass, wide pads, FM plucks, bells, hats). Notes are scheduled
// slightly ahead on the audio clock, and every musical event is also reported with its audio time
// so the visuals can land exactly on it.

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const rand = (a, b) => a + Math.random() * (b - a);

export const MOODS = {
    // 64 bpm, a resting heart: lub-dub on every beat. D major / B minor.
    heart: {
        bpm: 64,
        barsPerChord: 2,
        kick: 'heart',
        hats: 0,
        shaker: 0.22,
        clap: false,
        arpRate: 2,
        arpDensity: 0.42,
        chime: 0.16,
        swell: false,
        pad: 0.5,
        bass: 0.42,
        cutoff: [520, 1500],
        chords: [
            { root: 35, pad: [47, 54, 61, 62, 69] },  // Bm9
            { root: 31, pad: [43, 50, 57, 59, 66] },  // Gmaj9
            { root: 30, pad: [42, 50, 57, 61, 64] },  // Dmaj9/F#
            { root: 33, pad: [45, 52, 59, 61, 64] }   // Aadd9
        ],
        scale: [62, 64, 66, 69, 71, 74, 76, 78, 81, 83, 86]
    },
    // 116 bpm, four on the floor. F major / D minor.
    bloom: {
        bpm: 116,
        barsPerChord: 2,
        kick: 'four',
        hats: 0.85,
        shaker: 0.55,
        clap: true,
        arpRate: 4,
        arpDensity: 0.62,
        chime: 0.05,
        swell: false,
        pad: 0.42,
        bass: 0.5,
        cutoff: [700, 2600],
        chords: [
            { root: 38, pad: [50, 57, 60, 64, 65] },  // Dm9
            { root: 34, pad: [46, 53, 57, 60, 62] },  // Bbmaj9
            { root: 29, pad: [53, 57, 60, 64, 67] },  // Fmaj9
            { root: 36, pad: [48, 55, 57, 62, 64] }   // C6/9
        ],
        scale: [65, 67, 69, 72, 74, 77, 79, 81, 84, 86, 89]
    },
    // 56 bpm, no drums: slow swells and bells. E major.
    drift: {
        bpm: 56,
        barsPerChord: 2,
        kick: 'none',
        hats: 0,
        shaker: 0,
        clap: false,
        arpRate: 1,
        arpDensity: 0.3,
        chime: 0.5,
        swell: true,
        pad: 0.62,
        bass: 0.3,
        cutoff: [420, 1200],
        chords: [
            { root: 28, pad: [52, 56, 63, 66, 71] },  // Emaj9
            { root: 37, pad: [49, 56, 59, 63, 64] },  // C#m9
            { root: 33, pad: [45, 52, 56, 59, 61] },  // Amaj9
            { root: 35, pad: [47, 54, 59, 61, 64] }   // Bsus2(add4)
        ],
        scale: [64, 66, 68, 71, 73, 76, 78, 80, 83, 85, 88]
    }
};

export class Composer {
    /**
     * @param {AudioContext} ctx
     * @param {AudioNode} output
     * @param {(event: {time:number, type:string, vel?:number, note?:number}) => void} onEvent
     */
    constructor(ctx, output, onEvent) {
        this.ctx = ctx;
        this.onEvent = onEvent;
        this.mood = MOODS.heart;
        this.moodName = 'heart';
        this.pendingMood = null;
        this.playing = false;
        this.step = 0;
        this.nextTime = 0;
        this.timer = 0;
        this.motif = [];
        this.chordIndex = 0;
        this.cycle = 0;

        // --- buses ---------------------------------------------------------------------------
        this.out = ctx.createGain();
        this.out.gain.value = 0.9;

        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -16;
        comp.knee.value = 14;
        comp.ratio.value = 3;
        comp.attack.value = 0.008;
        comp.release.value = 0.22;
        this.out.connect(comp);
        comp.connect(output);

        // ducked: pads and bass dip under each kick
        this.duck = ctx.createGain();
        this.duck.connect(this.out);
        this.padBus = ctx.createGain();
        this.padBus.connect(this.duck);
        this.bassBus = ctx.createGain();
        this.bassBus.connect(this.duck);

        this.drums = ctx.createGain();
        this.drums.gain.value = 0.9;
        this.drums.connect(this.out);
        this.keys = ctx.createGain();
        this.keys.gain.value = 0.55;
        this.keys.connect(this.out);

        // reverb, from a generated impulse
        this.reverb = ctx.createConvolver();
        this.reverb.buffer = this.impulse(3.4, 2.6);
        this.reverbSend = ctx.createGain();
        const reverbReturn = ctx.createGain();
        reverbReturn.gain.value = 0.85;
        this.reverbSend.connect(this.reverb);
        this.reverb.connect(reverbReturn);
        reverbReturn.connect(this.out);

        // a soft dotted-eighth echo for the plucks
        this.delay = ctx.createDelay(2);
        this.delaySend = ctx.createGain();
        const feedback = ctx.createGain();
        feedback.gain.value = 0.36;
        const tone = ctx.createBiquadFilter();
        tone.type = 'lowpass';
        tone.frequency.value = 2600;
        const delayReturn = ctx.createStereoPanner();
        delayReturn.pan.value = 0.25;
        this.delaySend.connect(this.delay);
        this.delay.connect(tone);
        tone.connect(feedback);
        feedback.connect(this.delay);
        tone.connect(delayReturn);
        delayReturn.connect(this.out);
        delayReturn.connect(this.reverbSend);

        this.noise = this.noiseBuffer();
        this.applyTempo();
    }

    // --- transport -----------------------------------------------------------------------------

    start() {
        if (this.playing) return;
        this.playing = true;
        this.step = 0;
        this.cycle = 0;
        this.nextTime = this.ctx.currentTime + 0.08;
        this.tick();
        this.timer = setInterval(() => this.tick(), 25);
    }

    stop() {
        this.playing = false;
        clearInterval(this.timer);
        this.timer = 0;
    }

    setMood(name) {
        if (!MOODS[name]) return;
        if (!this.playing) {
            this.mood = MOODS[name];
            this.moodName = name;
            this.applyTempo();
            return;
        }
        this.pendingMood = name;
    }

    applyTempo() {
        this.sixteenth = 60 / this.mood.bpm / 4;
        this.delay.delayTime.setValueAtTime(this.sixteenth * 3, this.ctx.currentTime);
    }

    tick() {
        const horizon = this.ctx.currentTime + 0.14;
        while (this.nextTime < horizon) {
            this.schedule(this.step, this.nextTime);
            this.nextTime += this.sixteenth;
            this.step++;
        }
    }

    // --- the score -----------------------------------------------------------------------------

    schedule(step, t) {
        const s = step % 16;

        // mood changes land on a bar line, and restart the progression
        if (s === 0 && this.pendingMood) {
            this.mood = MOODS[this.pendingMood];
            this.moodName = this.pendingMood;
            this.pendingMood = null;
            this.applyTempo();
            this.step = step = 0;
            this.cycle = 0;
        }

        const m = this.mood;
        const bar = Math.floor(step / 16);
        const beat = 60 / m.bpm;
        const chordBars = m.barsPerChord;

        if (s === 0 && bar % chordBars === 0) {
            this.chordIndex = Math.floor(bar / chordBars) % m.chords.length;
            if (this.chordIndex === 0) this.cycle++;
            const chord = m.chords[this.chordIndex];
            const dur = chordBars * 4 * beat;
            this.pad(t, chord.pad, dur);
            this.bass(t, chord.root, dur);
            this.motif = this.makeMotif(chord, m);
            this.emit(t, 'chord', 1);
        }

        // drums
        if (m.kick === 'heart') {
            if (s % 4 === 0) this.kick(t, 1, 1);
            if (s % 4 === 1) this.kick(t + this.sixteenth * 0.1, 0.62, 0.86, 'dub');
        } else if (m.kick === 'four') {
            if (s % 4 === 0) this.kick(t, s === 0 ? 1 : 0.92, 1.12);
        }
        if (m.clap && (s === 4 || s === 12)) this.clap(t, 0.5);
        if (m.hats > 0 && s % 4 === 2) this.hat(t + this.swing(), m.hats * rand(0.8, 1), true);
        if (m.shaker > 0 && Math.random() < 0.85) {
            const accent = [1, 0.35, 0.6, 0.35][s % 4];
            this.hat(t + (s % 2 ? this.swing() : 0), m.shaker * accent * rand(0.7, 1), false);
        }
        if (m.swell && s === 0) this.emit(t, 'swell', 1);

        // plucks follow the motif of the current chord
        const per = 16 / (m.arpRate * 4);
        if (s % per === 0) {
            const idx = (Math.floor(step / per)) % this.motif.length;
            const note = this.motif[idx];
            if (note > 0) this.pluck(t + rand(0, 0.006), note, rand(0.55, 0.9));
        }

        // occasional bells
        if (s % 2 === 0 && Math.random() < m.chime / 8) {
            const note = m.scale[Math.floor(rand(4, m.scale.length))];
            this.chime(t, note, rand(0.35, 0.6));
        }
    }

    swing() {
        return this.mood.kick === 'four' ? this.sixteenth * 0.12 : 0;
    }

    /** A short phrase for one chord: chord tones an octave or two up, with rests. */
    makeMotif(chord, m) {
        const tones = chord.pad.slice(1).map((n) => n + 12);
        const high = tones.concat(tones.slice(0, 3).map((n) => n + 12)).sort((a, b) => a - b);
        const length = m.arpRate * 4;          // one bar
        const motif = [];
        let i = Math.floor(rand(0, 3));
        for (let k = 0; k < length; k++) {
            if (Math.random() > m.arpDensity && k % 4 !== 0) {
                motif.push(0);
                continue;
            }
            i = Math.max(0, Math.min(high.length - 1, i + Math.round(rand(-1.6, 1.8))));
            motif.push(high[i]);
        }
        return motif;
    }

    emit(time, type, vel = 1, note = 0) {
        this.onEvent({ time, type, vel, note });
    }

    // --- instruments ---------------------------------------------------------------------------

    kick(t, vel, pitch = 1, type = 'kick') {
        const ctx = this.ctx;
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(132 * pitch, t);
        osc.frequency.exponentialRampToValueAtTime(50 * pitch, t + 0.075);
        osc.frequency.exponentialRampToValueAtTime(41 * pitch, t + 0.4);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(vel, t + 0.004);
        g.gain.exponentialRampToValueAtTime(0.0001, t + (type === 'dub' ? 0.38 : 0.52));
        osc.connect(g);
        g.connect(this.drums);
        osc.start(t);
        osc.stop(t + 0.6);

        // soft felt click on top
        const n = ctx.createBufferSource();
        n.buffer = this.noise;
        const f = ctx.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = 1800;
        const ng = ctx.createGain();
        ng.gain.setValueAtTime(0.12 * vel, t);
        ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.025);
        n.connect(f);
        f.connect(ng);
        ng.connect(this.drums);
        n.start(t, Math.random() * 0.5);
        n.stop(t + 0.05);

        // sidechain
        const d = this.duck.gain;
        d.cancelScheduledValues(t);
        d.setTargetAtTime(1 - 0.55 * vel, t, 0.008);
        d.setTargetAtTime(1, t + 0.05, 0.14);

        this.emit(t, type, vel);
    }

    clap(t, vel) {
        const ctx = this.ctx;
        const f = ctx.createBiquadFilter();
        f.type = 'bandpass';
        f.frequency.value = 1400;
        f.Q.value = 0.9;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        // three quick bursts, then a tail
        [0, 0.011, 0.022].forEach((o) => {
            g.gain.setValueAtTime(vel * 0.8, t + o);
            g.gain.exponentialRampToValueAtTime(0.05, t + o + 0.009);
        });
        g.gain.setValueAtTime(vel * 0.6, t + 0.033);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
        const n = ctx.createBufferSource();
        n.buffer = this.noise;
        n.connect(f);
        f.connect(g);
        g.connect(this.drums);
        g.connect(this.reverbSend);
        n.start(t, Math.random() * 0.5);
        n.stop(t + 0.3);
        this.emit(t, 'clap', vel);
    }

    hat(t, vel, open) {
        const ctx = this.ctx;
        const n = ctx.createBufferSource();
        n.buffer = this.noise;
        const hp = ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = open ? 7200 : 8600;
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = open ? 10500 : 12000;
        bp.Q.value = 0.7;
        const g = ctx.createGain();
        const len = open ? 0.2 : 0.045;
        const amp = (open ? 0.11 : 0.07) * vel;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(amp, t + 0.002);
        g.gain.exponentialRampToValueAtTime(0.0001, t + len);
        const pan = ctx.createStereoPanner();
        pan.pan.value = open ? 0.2 : rand(-0.35, 0.35);
        n.connect(hp);
        hp.connect(bp);
        bp.connect(g);
        g.connect(pan);
        pan.connect(this.drums);
        n.start(t, Math.random() * 0.5);
        n.stop(t + len + 0.02);
        if (open) this.emit(t, 'hat', vel);
    }

    pad(t, notes, dur) {
        const ctx = this.ctx;
        const m = this.mood;
        const attack = Math.min(1.8, dur * 0.3);
        const release = 2.8;
        const level = m.pad * 0.16;

        const env = ctx.createGain();
        env.gain.setValueAtTime(0.0001, t);
        env.gain.linearRampToValueAtTime(level, t + attack);
        env.gain.setValueAtTime(level, t + dur);
        env.gain.setTargetAtTime(0.0001, t + dur, release / 4);
        env.connect(this.padBus);
        env.connect(this.reverbSend);

        // two filtered layers panned apart, each slightly detuned, for width
        [-1, 1].forEach((side) => {
            const filter = ctx.createBiquadFilter();
            filter.type = 'lowpass';
            filter.Q.value = 0.6;
            filter.frequency.setValueAtTime(m.cutoff[0], t);
            filter.frequency.linearRampToValueAtTime(m.cutoff[1], t + dur * 0.55);
            filter.frequency.linearRampToValueAtTime(m.cutoff[0] * 1.2, t + dur + release);
            const pan = ctx.createStereoPanner();
            pan.pan.value = side * 0.45;
            filter.connect(pan);
            pan.connect(env);
            notes.forEach((note, i) => {
                const osc = ctx.createOscillator();
                osc.type = i === 0 ? 'triangle' : 'sawtooth';
                osc.frequency.value = mtof(note);
                osc.detune.value = side * rand(5, 9);
                const g = ctx.createGain();
                g.gain.value = i === 0 ? 0.9 : 0.42;
                osc.connect(g);
                g.connect(filter);
                osc.start(t);
                osc.stop(t + dur + release + 0.2);
            });
        });
    }

    bass(t, note, dur) {
        const ctx = this.ctx;
        const level = this.mood.bass * 0.5;
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = mtof(note);
        const body = ctx.createOscillator();
        body.type = 'triangle';
        body.frequency.value = mtof(note + 12);
        const bodyGain = ctx.createGain();
        bodyGain.gain.value = 0.18;
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 260;
        const env = ctx.createGain();
        env.gain.setValueAtTime(0.0001, t);
        env.gain.linearRampToValueAtTime(level, t + 0.12);
        env.gain.setValueAtTime(level, t + dur - 0.05);
        env.gain.setTargetAtTime(0.0001, t + dur - 0.05, 0.08);
        osc.connect(lp);
        body.connect(bodyGain);
        bodyGain.connect(lp);
        lp.connect(env);
        env.connect(this.bassBus);
        osc.start(t);
        body.start(t);
        osc.stop(t + dur + 0.5);
        body.stop(t + dur + 0.5);
    }

    /** FM pluck: warm attack, quick decay, into echo and room. */
    pluck(t, note, vel) {
        const ctx = this.ctx;
        const f = mtof(note);
        const car = ctx.createOscillator();
        car.type = 'sine';
        car.frequency.value = f;
        const mod = ctx.createOscillator();
        mod.type = 'sine';
        mod.frequency.value = f * 2;
        const index = ctx.createGain();
        index.gain.setValueAtTime(f * 2.4 * vel, t);
        index.gain.exponentialRampToValueAtTime(f * 0.05, t + 0.35);
        mod.connect(index);
        index.connect(car.frequency);
        const env = ctx.createGain();
        env.gain.setValueAtTime(0.0001, t);
        env.gain.exponentialRampToValueAtTime(0.2 * vel, t + 0.004);
        env.gain.exponentialRampToValueAtTime(0.0001, t + 0.95);
        const pan = ctx.createStereoPanner();
        pan.pan.value = rand(-0.5, 0.5);
        car.connect(env);
        env.connect(pan);
        pan.connect(this.keys);
        pan.connect(this.delaySend);
        pan.connect(this.reverbSend);
        car.start(t);
        mod.start(t);
        car.stop(t + 1);
        mod.stop(t + 1);
        this.emit(t, 'pluck', vel, note);
    }

    /** FM bell with an inharmonic ratio and a long tail. */
    chime(t, note, vel) {
        const ctx = this.ctx;
        const f = mtof(note);
        const car = ctx.createOscillator();
        car.frequency.value = f;
        const mod = ctx.createOscillator();
        mod.frequency.value = f * 3.51;
        const index = ctx.createGain();
        index.gain.setValueAtTime(f * 1.6, t);
        index.gain.exponentialRampToValueAtTime(f * 0.02, t + 2.2);
        mod.connect(index);
        index.connect(car.frequency);
        const shimmer = ctx.createOscillator();
        shimmer.frequency.value = f * 2.006;
        const shimmerGain = ctx.createGain();
        shimmerGain.gain.value = 0.25;
        const env = ctx.createGain();
        env.gain.setValueAtTime(0.0001, t);
        env.gain.exponentialRampToValueAtTime(0.16 * vel, t + 0.006);
        env.gain.exponentialRampToValueAtTime(0.0001, t + 3.2);
        const pan = ctx.createStereoPanner();
        pan.pan.value = rand(-0.6, 0.6);
        car.connect(env);
        shimmer.connect(shimmerGain);
        shimmerGain.connect(env);
        env.connect(pan);
        pan.connect(this.keys);
        pan.connect(this.reverbSend);
        [car, mod, shimmer].forEach((o) => {
            o.start(t);
            o.stop(t + 3.3);
        });
        this.emit(t, 'chime', vel, note);
    }

    /**
     * A note played by a tap on the scene: higher in the tree, higher in the scale.
     *
     * @param {number} height - 0 (ground) to 1 (top of the canopy)
     */
    tap(height) {
        const scale = this.mood.scale;
        const i = Math.max(0, Math.min(scale.length - 1, Math.round(height * (scale.length - 1))));
        const t = this.ctx.currentTime + 0.01;
        this.chime(t, scale[i], 0.9);
        this.pluck(t, scale[i] - 12, 0.7);
    }

    // --- buffers -------------------------------------------------------------------------------

    noiseBuffer() {
        const len = this.ctx.sampleRate;
        const buffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
        return buffer;
    }

    impulse(seconds, decay) {
        const rate = this.ctx.sampleRate;
        const len = Math.floor(rate * seconds);
        const buffer = this.ctx.createBuffer(2, len, rate);
        for (let ch = 0; ch < 2; ch++) {
            const data = buffer.getChannelData(ch);
            let lp = 0;
            for (let i = 0; i < len; i++) {
                const x = i / len;
                // darker as it decays: a one-pole lowpass whose cutoff falls over time
                const white = Math.random() * 2 - 1;
                const k = 0.55 - 0.45 * x;
                lp += (white - lp) * k;
                const pre = i < rate * 0.012 ? 0 : 1;
                data[i] = lp * Math.pow(1 - x, decay) * pre;
            }
        }
        return buffer;
    }
}
