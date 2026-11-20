import { Composer } from './music.js';
import { BARS, MELODY_ROWS, STEPS, bassPitch, chordVoicing, melodyPitch } from './song.js';

// Plays a studio song with the composer's instruments and buses (kick with sidechain, pads, FM
// plucks and bells, reverb, echo). Every note is reported with the part, step and row it came
// from, so the studio can light its square and the tree can draw it.

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

export class Sequencer extends Composer {
    constructor(ctx, output, onEvent) {
        super(ctx, output, onEvent);
        // what the inherited instruments read: pad level and filter sweep, bass level
        this.mood = { bpm: 92, kick: 'heart', pad: 0.5, bass: 0.5, cutoff: [620, 1900], chords: [], scale: [] };
        this.song = null;
        this.tag = null;                     // part, step and row of the note being played
        this.anchor = { time: 0, step: 0 };  // the last scheduled step and its audio time
        this.liveSkip = null;                // a note just written live, not to be played twice
    }

    applyTempo() {
        const bpm = this.song?.bpm ?? this.mood.bpm;
        this.sixteenth = 60 / bpm / 4;
        this.delay.delayTime.setTargetAtTime(this.sixteenth * 3, this.ctx.currentTime, 0.03);
    }

    start() {
        this.applyTempo();
        super.start();
    }

    get bar() {
        return Math.floor(this.anchor.step / STEPS) % BARS;
    }

    emit(time, type, vel = 1, note = 0) {
        this.onEvent(this.tag ? { time, type, vel, note, ...this.tag } : { time, type, vel, note });
    }

    schedule(step, t) {
        const song = this.song;
        if (!song) return;

        // a new tempo takes over from this step
        if (Math.abs(60 / song.bpm / 4 - this.sixteenth) > 1e-6) this.applyTempo();

        const s = step % STEPS;
        const bar = Math.floor(step / STEPS) % BARS;
        const chord = song.chords[bar];
        this.anchor.time = t;
        this.anchor.step = step;

        this.tag = { step: s, bar };
        this.emit(t, 'step');

        if (s === 0 && !song.mute.chords) {
            this.pad(t, chordVoicing(song, chord), STEPS * this.sixteenth);
            this.tag = { part: 'chords', bar };
            this.emit(t, 'chord', 1);
        }

        const h = song.heart[s];
        if (h && !song.mute.heart) {
            this.tag = { part: 'heart', step: s };
            if (h === 2) this.kick(t, 1, 1);
            else this.kick(t, 0.62, 0.86, 'dub');
        }

        const c = song.clap[s];
        if (c && !song.mute.clap) {
            this.tag = { part: 'clap', step: s };
            this.clap(t, c === 2 ? 0.5 : 0.22);
        }

        const hh = song.hats[s];
        if (hh && !song.mute.hats) {
            this.tag = { part: 'hats', step: s };
            const accent = s % 4 === 0 ? 1 : s % 2 === 0 ? 0.82 : 0.62;
            this.hat(t, (hh === 2 ? 0.8 : 0.6) * accent, hh === 2);
            // the composer's hat only reports open ones
            if (hh !== 2) this.emit(t, 'hat', 0.45 * accent);
        }

        const b = song.bass[s];
        if (b >= 0 && !song.mute.bass) {
            // held until the next bass note, or the end of the bar
            let len = 1;
            while (s + len < STEPS && song.bass[s + len] < 0) len++;
            this.tag = { part: 'bass', step: s, row: b, len };
            this.bassNote(t, bassPitch(song, chord, b), len * this.sixteenth, s % 4 === 0 ? 1 : 0.85);
        }

        const m = song.melody[s];
        if (m && !song.mute.melody) {
            const vel = s % 4 === 0 ? 0.86 : s % 2 === 0 ? 0.74 : 0.64;
            for (let row = 0; row < MELODY_ROWS; row++) {
                if (!(m & (1 << row))) continue;
                const skip = this.liveSkip;
                if (skip && skip.step === s && skip.row === row && t < skip.until) continue;
                this.tag = { part: 'melody', step: s, row };
                this.lead(t, melodyPitch(song, row), vel);
            }
        }
        this.tag = null;
    }

    /** The melody's sound: the FM pluck, or the bell. */
    lead(t, note, vel) {
        if (this.song?.lead === 'bell') this.chime(t, note, vel * 0.78);
        else this.pluck(t, note, vel);
    }

    /**
     * Plays a melody row now, from a tap or a key. While the song runs, returns the step it
     * falls on (rounded to the nearest, by when it is heard), else null.
     *
     * @param {number} row
     * @param {number} heard - the audio time being heard now
     * @param {'tap'|'key'} source
     */
    live(row, heard, source) {
        const t = this.ctx.currentTime + 0.005;
        let step = null;
        if (this.playing) {
            const k = Math.round((heard - this.anchor.time) / this.sixteenth);
            step = (((this.anchor.step + k) % STEPS) + STEPS) % STEPS;
            // if that step is still to be scheduled, it shouldn't sound a second time
            this.liveSkip = { step, row, until: t + this.sixteenth * 2 + 0.2 };
        }
        this.tag = { part: 'melody', row, live: source, ...(step === null ? {} : { step }) };
        this.lead(t, melodyPitch(this.song, row), 0.85);
        this.tag = null;
        return step;
    }

    /** A short taste of one square of the studio, as it is edited. */
    preview(part, row, value) {
        const song = this.song;
        if (!song) return;
        const t = this.ctx.currentTime + 0.005;
        const chord = song.chords[this.playing ? this.bar : 0];
        this.tag = { part, row, preview: true };
        switch (part) {
            case 'melody':
                this.lead(t, melodyPitch(song, row), 0.8);
                break;
            case 'bass':
                this.bassNote(t, bassPitch(song, chord, row), 0.45, 0.9);
                break;
            case 'chords':
                this.pad(t, chordVoicing(song, row), 1.2);
                break;
            case 'heart':
                if (value === 2) this.kick(t, 1, 1);
                else this.kick(t, 0.62, 0.86, 'dub');
                break;
            case 'clap':
                this.clap(t, value === 2 ? 0.5 : 0.22);
                break;
            case 'hats':
                this.hat(t, value === 2 ? 0.8 : 0.6, value === 2);
                break;
        }
        this.tag = null;
    }

    /** A plucked sub bass: a sine with a little saw on top, a filter that closes, and a hold. */
    bassNote(t, note, dur, vel) {
        const ctx = this.ctx;
        const f = mtof(note);
        const sub = ctx.createOscillator();
        sub.type = 'sine';
        sub.frequency.value = f;
        const edge = ctx.createOscillator();
        edge.type = 'sawtooth';
        edge.frequency.value = f;
        edge.detune.value = 4;
        const edgeGain = ctx.createGain();
        edgeGain.gain.value = 0.2;
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.Q.value = 1.6;
        lp.frequency.setValueAtTime(1100, t);
        lp.frequency.exponentialRampToValueAtTime(260, t + 0.2);

        const peak = 0.36 * vel;
        const hold = 0.25 * vel;
        const end = t + Math.max(0.1, dur - 0.02);
        const env = ctx.createGain();
        env.gain.setValueAtTime(0.0001, t);
        env.gain.exponentialRampToValueAtTime(peak, t + 0.006);
        env.gain.exponentialRampToValueAtTime(hold, Math.min(end, t + 0.14));
        env.gain.setValueAtTime(hold, end);
        env.gain.exponentialRampToValueAtTime(0.0001, end + 0.1);

        sub.connect(lp);
        edge.connect(edgeGain);
        edgeGain.connect(lp);
        lp.connect(env);
        env.connect(this.bassBus);
        sub.start(t);
        edge.start(t);
        sub.stop(end + 0.15);
        edge.stop(end + 0.15);
        this.emit(t, 'bass', vel, note);
    }
}
