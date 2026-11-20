import { Composer } from './music.js';

// Audio: one context, three sources (the generative score, a track of your own, the
// microphone), and an analyser that turns whatever is playing into smoothed bass / mid / high
// levels, spectrum bars for the UI, and beat events.

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const BAR_COUNT = 14;

export class AudioEngine {
    constructor() {
        this.ctx = null;
        this.mode = 'synth';           // 'synth' | 'file' | 'mic'
        this.playing = false;
        this.events = [];
        this.levels = { bass: 0, mid: 0, high: 0, level: 0 };
        this.bars = new Float32Array(BAR_COUNT);
        this.peaks = { bass: 0.3, mid: 0.3, high: 0.3, level: 0.3 };
        this.bassAvg = 0;
        this.armed = true;
        this.lastBeat = 0;
        this.fileName = '';
    }

    get ready() {
        return !!this.ctx;
    }

    /** Audio time the listener is hearing now (scheduled events at or before it are due). */
    get heardTime() {
        if (!this.ctx) return 0;
        return this.ctx.currentTime - (this.ctx.outputLatency || 0) - (this.ctx.baseLatency || 0);
    }

    /** Must be called from a user gesture. */
    async init() {
        if (this.ctx) {
            if (this.ctx.state === 'suspended') await this.ctx.resume();
            return;
        }
        const AC = window.AudioContext || window.webkitAudioContext;
        const ctx = new AC({ latencyHint: 'interactive' });
        this.ctx = ctx;
        // iOS: play through the silent switch, like a music app
        try {
            if (navigator.audioSession) navigator.audioSession.type = 'playback';
        } catch {
            // not supported
        }

        this.master = ctx.createGain();
        this.master.gain.value = 0;
        this.master.connect(ctx.destination);

        this.analyser = ctx.createAnalyser();
        this.analyser.fftSize = 2048;
        this.analyser.smoothingTimeConstant = 0.5;
        this.analyser.minDecibels = -92;
        this.analyser.maxDecibels = -18;
        this.master.connect(this.analyser);
        this.freq = new Uint8Array(this.analyser.frequencyBinCount);
        this.barEdges = makeBarEdges(BAR_COUNT, 40, 12000, ctx.sampleRate / this.analyser.fftSize, this.freq.length);

        this.composer = new Composer(ctx, this.master, (e) => this.events.push(e));

        this.fileGain = ctx.createGain();
        this.fileGain.connect(this.master);

        // the microphone is analysed but never sent to the speakers
        this.micGain = ctx.createGain();
        this.micGain.gain.value = 1.4;
        this.micGain.connect(this.analyser);

        if (ctx.state === 'suspended') await ctx.resume();
    }

    fade(to, seconds = 0.6) {
        const g = this.master.gain;
        const now = this.ctx.currentTime;
        g.cancelScheduledValues(now);
        g.setValueAtTime(g.value, now);
        g.linearRampToValueAtTime(to, now + seconds);
    }

    // --- sources -------------------------------------------------------------------------------

    playSynth(mood) {
        this.stopFile();
        this.stopMic();
        this.mode = 'synth';
        if (mood) this.composer.setMood(mood);
        this.composer.start();
        this.fade(0.85, 1.6);
        this.playing = true;
    }

    setMood(mood) {
        this.composer?.setMood(mood);
    }

    /** @param {File} file */
    async playFile(file) {
        await this.init();
        this.composer.stop();
        this.stopMic();
        if (!this.audioEl) {
            this.audioEl = new Audio();
            this.audioEl.loop = true;
            this.audioEl.crossOrigin = 'anonymous';
            this.fileSource = this.ctx.createMediaElementSource(this.audioEl);
            this.fileSource.connect(this.fileGain);
        }
        if (this.fileUrl) URL.revokeObjectURL(this.fileUrl);
        this.fileUrl = URL.createObjectURL(file);
        this.audioEl.src = this.fileUrl;
        this.fileName = file.name.replace(/\.[^.]+$/, '');
        this.mode = 'file';
        this.resetAnalysis();
        await this.audioEl.play();
        this.fade(0.9, 0.4);
        this.playing = true;
    }

    stopFile() {
        if (this.audioEl && !this.audioEl.paused) this.audioEl.pause();
    }

    async useMic() {
        await this.init();
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('No microphone access in this browser');
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        });
        this.composer.stop();
        this.stopFile();
        this.fade(0, 0.3);
        this.stopMic();
        this.micStream = stream;
        this.micSource = this.ctx.createMediaStreamSource(stream);
        this.micSource.connect(this.micGain);
        this.mode = 'mic';
        this.resetAnalysis();
        this.playing = true;
    }

    stopMic() {
        if (this.micSource) {
            this.micSource.disconnect();
            this.micSource = null;
        }
        if (this.micStream) {
            this.micStream.getTracks().forEach((t) => t.stop());
            this.micStream = null;
        }
    }

    pause() {
        if (!this.ctx || !this.playing) return;
        this.playing = false;
        if (this.mode === 'synth') {
            this.fade(0, 0.35);
            setTimeout(() => {
                if (!this.playing && this.mode === 'synth') this.composer.stop();
            }, 400);
        } else if (this.mode === 'file') {
            this.fade(0, 0.2);
            setTimeout(() => {
                if (!this.playing) this.audioEl?.pause();
            }, 220);
        } else {
            this.stopMic();
        }
    }

    async resume() {
        await this.init();
        if (this.mode === 'synth') this.playSynth();
        else if (this.mode === 'file' && this.audioEl?.src) {
            await this.audioEl.play();
            this.fade(0.9, 0.3);
            this.playing = true;
        } else if (this.mode === 'mic') {
            await this.useMic();
        }
    }

    /** A harmonised note for a tap on the scene; only over the generative score. */
    tap(height) {
        if (this.ctx && this.playing && this.mode === 'synth') this.composer.tap(height);
    }

    /** Events whose audio time has been reached. */
    drainEvents() {
        if (!this.events.length) return EMPTY;
        const now = this.heardTime;
        const due = [];
        let keep = 0;
        for (const e of this.events) {
            if (e.time <= now) due.push(e);
            else this.events[keep++] = e;
        }
        this.events.length = keep;
        return due;
    }

    resetAnalysis() {
        this.peaks = { bass: 0.3, mid: 0.3, high: 0.3, level: 0.3 };
        this.bassAvg = 0;
        this.events.length = 0;
    }

    // --- analysis ------------------------------------------------------------------------------

    analyse(dt) {
        const L = this.levels;
        if (!this.ctx) return L;
        const f = this.freq;
        this.analyser.getByteFrequencyData(f);
        const binHz = this.ctx.sampleRate / this.analyser.fftSize;
        const band = (lo, hi) => {
            const a = Math.max(1, Math.floor(lo / binHz));
            const b = Math.min(f.length - 1, Math.ceil(hi / binHz));
            let sum = 0;
            for (let i = a; i <= b; i++) sum += f[i];
            return sum / ((b - a + 1) * 255);
        };
        const raw = {
            bass: band(35, 150),
            mid: band(220, 2400),
            high: band(3200, 11000)
        };
        raw.level = raw.bass * 0.45 + raw.mid * 0.35 + raw.high * 0.2;

        // normalise against a slowly falling peak, so quiet and loud sources both move things
        for (const k of ['bass', 'mid', 'high', 'level']) {
            this.peaks[k] = Math.max(raw[k], this.peaks[k] * Math.exp(-dt * 0.18), 0.12);
            const v = clamp01(raw[k] / this.peaks[k]);
            const shaped = v * v;
            const rate = shaped > L[k] ? 20 : 4.5;
            L[k] += (shaped - L[k]) * (1 - Math.exp(-dt * rate));
        }

        // spectrum bars for the UI
        for (let i = 0; i < BAR_COUNT; i++) {
            const [a, b] = this.barEdges[i];
            let sum = 0;
            for (let j = a; j <= b; j++) sum += f[j];
            const v = clamp01(sum / ((b - a + 1) * 255) * 1.25);
            this.bars[i] += (v - this.bars[i]) * (1 - Math.exp(-dt * (v > this.bars[i] ? 24 : 7)));
        }

        // beats for sources without a score: rising edges of the bass over its recent average
        if (this.mode !== 'synth' && this.playing) {
            const b = raw.bass;
            this.bassAvg += (b - this.bassAvg) * (1 - Math.exp(-dt * 3));
            const now = this.ctx.currentTime;
            if (b < this.bassAvg * 1.04) this.armed = true;
            if (this.armed && b > this.bassAvg * 1.16 + 0.02 && b > 0.22 && now - this.lastBeat > 0.26) {
                this.armed = false;
                this.lastBeat = now;
                this.events.push({ time: now - 1, type: 'kick', vel: clamp01(0.45 + (b - this.bassAvg) * 3) });
            }
        }
        return L;
    }
}

const EMPTY = [];

function makeBarEdges(count, lo, hi, binHz, bins) {
    const edges = [];
    for (let i = 0; i < count; i++) {
        const f0 = lo * Math.pow(hi / lo, i / count);
        const f1 = lo * Math.pow(hi / lo, (i + 1) / count);
        const a = Math.max(1, Math.floor(f0 / binHz));
        const b = Math.min(bins - 1, Math.max(a, Math.ceil(f1 / binHz)));
        edges.push([a, b]);
    }
    return edges;
}
