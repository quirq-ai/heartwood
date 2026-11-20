// Songs for the studio. A song is one bar of 16 steps for each part, looped under a progression
// of four chords, one per bar. Everything is stored relative to the key: the melody as rows of
// the key's pentatonic scale, the bass as tones of the bar's chord, the chords as scale degrees.
// So changing the key or a chord carries the whole song with it, and no note can be out of key.

export const STEPS = 16;
export const BARS = 4;
export const MELODY_ROWS = 8;
export const BASS_ROWS = 4;                 // root, third, fifth, octave of the bar's chord
export const DRUMS = ['heart', 'clap', 'hats'];
export const PARTS = ['chords', 'melody', 'bass', 'heart', 'clap', 'hats'];

export const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];

// `pent` picks the pentatonic notes out of the scale; `chords` are the degrees offered as chords
// (the diminished one is left out)
export const SCALES = {
    minor: { steps: [0, 2, 3, 5, 7, 8, 10], pent: [0, 2, 3, 4, 6], chords: [0, 2, 3, 4, 5, 6] },
    major: { steps: [0, 2, 4, 5, 7, 9, 11], pent: [0, 1, 2, 4, 5], chords: [0, 1, 2, 3, 4, 5] }
};

/** Semitones from the key's root up to scale degree `deg` (0 is the root, 7 the octave). */
function semis(scale, deg) {
    return Math.floor(deg / 7) * 12 + SCALES[scale].steps[deg % 7];
}

/** MIDI note of melody row `row` (0 is the lowest): the pentatonic scale from about A3 up. */
export function melodyPitch(song, row) {
    const pent = SCALES[song.scale].pent;
    const deg = pent[row % 5] + 7 * Math.floor(row / 5);
    return 57 + ((song.root + 3) % 12) + semis(song.scale, deg);
}

/** MIDI note of bass row `row` (root, third, fifth, octave) under chord degree `d`, E1 to E2. */
export function bassPitch(song, d, row) {
    let root = 28 + ((song.root + 8) % 12) + semis(song.scale, d);
    if (root > 40) root -= 12;
    const third = semis(song.scale, d + 2) - semis(song.scale, d);
    const fifth = semis(song.scale, d + 4) - semis(song.scale, d);
    return root + [0, third, fifth, 12][row];
}

/** The pad's voicing of chord degree `d`: root, fifth, ninth (when it is a whole tone), third and seventh. */
export function chordVoicing(song, d) {
    const base = 43 + ((song.root + semis(song.scale, d) + 5) % 12);   // chord root, G2 to F♯3
    const iv = (k) => semis(song.scale, d + k) - semis(song.scale, d);
    const notes = [base, base + iv(4), base + iv(2) + 12, base + iv(6) + 12];
    if (iv(1) === 2) notes.push(base + 14);
    return notes.sort((a, b) => a - b);
}

export function chordName(song, d) {
    const pc = (song.root + semis(song.scale, d)) % 12;
    const third = semis(song.scale, d + 2) - semis(song.scale, d);
    return NOTE_NAMES[pc] + (third === 3 ? 'm' : '');
}

export function keyName(song) {
    return `${NOTE_NAMES[song.root]} ${song.scale}`;
}

// --- songs -------------------------------------------------------------------------------------

const empty = () => new Array(STEPS).fill(0);
const fromString = (s) => [...s].map(Number);

function melodyFrom(notes) {
    const m = empty();
    for (const [step, row] of notes) m[step] |= 1 << row;
    return m;
}

function bassFrom(notes) {
    const b = new Array(STEPS).fill(-1);
    for (const [step, row] of notes) b[step] = row;
    return b;
}

export function blankSong({ bpm = 92, root = 2, scale = 'minor', chords = null } = {}) {
    return {
        bpm,
        root,
        scale,
        chords: chords ? [...chords] : scale === 'major' ? [0, 4, 5, 3] : [0, 5, 2, 6],
        melody: empty(),                          // a bit per row, per step
        bass: new Array(STEPS).fill(-1),          // one row per step, or -1
        heart: empty(),                           // 0 off, 2 lub, 1 dub
        clap: empty(),                            // 0 off, 2 clap, 1 ghost
        hats: empty(),                            // 0 off, 1 closed, 2 open
        lead: 'pluck',                            // or 'bell'
        mute: { chords: false, melody: false, bass: false, heart: false, clap: false, hats: false }
    };
}

/** The same key, tempo, chords and sound, with every part empty. */
export function clearedSong(song) {
    const s = blankSong({ bpm: song.bpm, root: song.root, scale: song.scale, chords: song.chords });
    s.lead = song.lead;
    return s;
}

// the three moods of the generative score, as songs to start from
export const PRESETS = {
    heart: () => ({
        ...blankSong({ bpm: 64, root: 11, scale: 'minor', chords: [0, 5, 2, 6] }),
        heart: fromString('2100210021002100'),
        hats: fromString('0010001000100010'),
        bass: bassFrom([[0, 0], [10, 2]]),
        melody: melodyFrom([[0, 5], [2, 3], [6, 4], [8, 5], [10, 6], [14, 4]])
    }),
    bloom: () => ({
        ...blankSong({ bpm: 116, root: 2, scale: 'minor', chords: [0, 5, 2, 6] }),
        heart: fromString('2000200020002000'),
        clap: fromString('0000200000002000'),
        hats: fromString('1121112111211121'),
        bass: bassFrom([[2, 0], [6, 0], [10, 0], [14, 3]]),
        melody: melodyFrom([[0, 5], [3, 4], [6, 3], [8, 5], [10, 6], [11, 5], [14, 3]])
    }),
    drift: () => ({
        ...blankSong({ bpm: 56, root: 4, scale: 'major', chords: [0, 5, 3, 4] }),
        bass: bassFrom([[0, 0]]),
        melody: melodyFrom([[0, 4], [6, 6], [10, 5]]),
        lead: 'bell'
    })
};

/** Chord degrees that don't exist in a new scale move to their nearest neighbour that does. */
export function fitChords(song) {
    const ok = SCALES[song.scale].chords;
    song.chords = song.chords.map((d) => (ok.includes(d) ? d : song.scale === 'major' ? 4 : 3));
}

// --- making parts up -------------------------------------------------------------------------------

const rnd = Math.random;
const pick = (a) => a[Math.floor(rnd() * a.length)];
const chance = (p) => rnd() < p;

/** Picks a value from [[weight, value], ...]. */
function weighted(items) {
    let x = rnd() * items.reduce((sum, [w]) => sum + w, 0);
    for (const [w, v] of items) {
        x -= w;
        if (x <= 0) return v;
    }
    return items[items.length - 1][1];
}

const PROGRESSIONS = {
    minor: [[0, 5, 2, 6], [0, 3, 5, 4], [0, 6, 5, 6], [5, 6, 0, 0], [0, 5, 3, 4], [0, 2, 6, 3], [0, 3, 0, 4], [3, 5, 0, 6]],
    major: [[0, 4, 5, 3], [5, 3, 0, 4], [0, 5, 3, 4], [3, 0, 4, 5], [0, 3, 0, 4], [0, 2, 3, 4], [0, 4, 3, 3], [3, 4, 5, 5]]
};

// drum patterns by tempo: slow (under 78 bpm), mid, fast (104 and up)
const PATTERNS = {
    heart: {
        slow: ['2100210021002100', '2100000021000000', '2000000020000000', '2100000021002100'],
        mid: ['2000200020002000', '2000000020100000', '2001002000200000', '2000001020000000'],
        fast: ['2000200020002000', '2001002000200000', '2000200020002010', '2000200020102000']
    },
    clap: {
        slow: ['0000000020000000', '0000000020000001', '0000000000000000'],
        mid: ['0000200000002000', '0000000020000000', '0000200000002001', '0000200100002000'],
        fast: ['0000200000002000', '0000200000002010', '0000200100002000']
    },
    hats: {
        slow: ['0010001000100010', '1010101010101010', '0000002000000020', '0000000000000000'],
        mid: ['1010101010101010', '0020002000200020', '1111111111111111', '1012101210121012'],
        fast: ['1121112111211121', '0020002000200020', '1111111111111111', '1010201010102010']
    }
};

const BASS_RHYTHMS = {
    slow: [[0], [0, 8], [0, 10], [0, 6, 8]],
    mid: [[0, 8], [0, 4, 8, 12], [0, 3, 6, 10, 12], [0, 6, 8, 14], [0, 10]],
    fast: [[2, 6, 10, 14], [0, 2, 4, 6, 8, 10, 12, 14], [0, 3, 6, 10, 12], [0, 6, 8, 14], [0, 4, 8, 12]]
};

const band = (bpm) => (bpm < 78 ? 'slow' : bpm < 104 ? 'mid' : 'fast');
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/** Tries a few times for something different from what is there now. */
function fresh(current, make) {
    for (let i = 0; i < 8; i++) {
        const next = make();
        if (!same(next, current)) return next;
    }
    return make();
}

function drums(part, bpm) {
    const out = fromString(pick(PATTERNS[part][band(bpm)]));
    // now and then a ghost note on an empty off-beat
    if (part !== 'hats' && out.some((v) => v) && chance(0.3)) {
        const free = out.map((v, i) => (!v && i % 2 ? i : -1)).filter((i) => i >= 0);
        if (free.length) out[pick(free)] = 1;
    }
    return out;
}

function makeBass(bpm) {
    const out = new Array(STEPS).fill(-1);
    pick(BASS_RHYTHMS[band(bpm)]).forEach((step, i) => {
        out[step] = i === 0 ? 0 : weighted([[5, 0], [2, 2], [1.5, 3], [1, 1]]);
    });
    return out;
}

function makeMelody(bpm) {
    const out = empty();
    const b = band(bpm);
    const count = b === 'slow' ? 3 + Math.floor(rnd() * 3) : b === 'mid' ? 4 + Math.floor(rnd() * 4) : 5 + Math.floor(rnd() * 4);
    // on the beat is likelier than off it
    const pool = [...Array(STEPS).keys()].map((s) => [s % 4 === 0 ? 3 : s % 2 === 0 ? 1.6 : 0.55, s]);
    const steps = [];
    while (steps.length < count) {
        const s = weighted(pool);
        steps.push(s);
        pool.splice(pool.findIndex(([, v]) => v === s), 1);
    }
    steps.sort((a, b2) => a - b2);
    let row = 2 + Math.floor(rnd() * 4);
    steps.forEach((s, i) => {
        if (i > 0) {
            row += weighted([[1, -2], [3, -1], [1.2, 0], [3, 1], [1, 2]]);
            if (row < 0) row = 1;
            if (row >= MELODY_ROWS) row = MELODY_ROWS - 2;
        }
        // the phrase comes home to the root, the fifth or the octave
        if (i === steps.length - 1) row = [0, 3, 5].reduce((a, c) => (Math.abs(c - row) < Math.abs(a - row) ? c : a));
        out[s] |= 1 << row;
        if (row <= MELODY_ROWS - 3 && chance(0.1)) out[s] |= 1 << (row + 2);
    });
    return out;
}

/** A new pattern for one part of the song, different from the one it has. */
export function generatePart(part, song) {
    switch (part) {
        case 'chords':
            return fresh(song.chords, () => [...pick(PROGRESSIONS[song.scale])]);
        case 'melody':
            return fresh(song.melody, () => makeMelody(song.bpm));
        case 'bass':
            return fresh(song.bass, () => makeBass(song.bpm));
        default:
            return fresh(song[part], () => drums(part, song.bpm));
    }
}

export const STYLES = ['heart', 'bloom', 'drift', 'groove'];

/** A whole new song: a random key, and a tempo and parts in the manner of `style`. */
export function generateSong(style = pick(STYLES)) {
    const [lo, hi] = { heart: [60, 72], bloom: [108, 124], drift: [52, 62], groove: [84, 100] }[style];
    const scale = style === 'drift' ? (chance(0.7) ? 'major' : 'minor') : chance(0.65) ? 'minor' : 'major';
    const song = blankSong({ bpm: Math.round(lo + rnd() * (hi - lo)), root: Math.floor(rnd() * 12), scale });
    song.chords = generatePart('chords', song);
    if (style !== 'drift') {
        song.heart = generatePart('heart', song);
        song.hats = generatePart('hats', song);
        if (style !== 'heart' || chance(0.5)) song.clap = generatePart('clap', song);
    }
    song.bass = generatePart('bass', song);
    song.melody = generatePart('melody', song);
    song.lead = style === 'drift' || chance(0.2) ? 'bell' : 'pluck';
    return song;
}

// --- sharing: a song in 42 bytes, as 56 URL-safe characters ---------------------------------------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const SONG_BYTES = 42;
const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v) || lo));

function toB64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 3) {
        const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
        s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
    }
    return s.slice(0, Math.ceil((bytes.length * 4) / 3));
}

function fromB64(str) {
    const out = [];
    let n = 0;
    let bits = 0;
    for (const ch of str) {
        const v = B64.indexOf(ch);
        if (v < 0) return null;
        n = (n << 6) | v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out.push((n >> bits) & 255);
            n &= (1 << bits) - 1;
        }
    }
    return out;
}

export function encodeSong(s) {
    const b = new Uint8Array(SONG_BYTES);
    b[0] = 1;
    b[1] = clampInt(s.bpm, 40, 200);
    b[2] = (s.root & 15) | (s.scale === 'major' ? 16 : 0) | (s.lead === 'bell' ? 32 : 0);
    b[3] = PARTS.reduce((m, p, i) => m | (s.mute[p] ? 1 << i : 0), 0);
    b[4] = (s.chords[0] & 15) | ((s.chords[1] & 15) << 4);
    b[5] = (s.chords[2] & 15) | ((s.chords[3] & 15) << 4);
    for (let i = 0; i < STEPS; i++) b[6 + i] = s.melody[i] & 255;
    for (let i = 0; i < 8; i++) b[22 + i] = ((s.bass[2 * i] + 1) & 15) | (((s.bass[2 * i + 1] + 1) & 15) << 4);
    DRUMS.forEach((part, k) => {
        for (let i = 0; i < 4; i++) {
            let v = 0;
            for (let j = 0; j < 4; j++) v |= (s[part][4 * i + j] & 3) << (2 * j);
            b[30 + 4 * k + i] = v;
        }
    });
    return toB64(b);
}

/** The song in a code made by encodeSong, or null if the code isn't one. */
export function decodeSong(code) {
    const b = typeof code === 'string' ? fromB64(code) : null;
    if (!b || b.length < SONG_BYTES || b[0] !== 1) return null;
    const scale = b[2] & 16 ? 'major' : 'minor';
    const ok = SCALES[scale].chords;
    const s = blankSong({ bpm: clampInt(b[1], 40, 200), root: (b[2] & 15) % 12, scale });
    s.lead = b[2] & 32 ? 'bell' : 'pluck';
    PARTS.forEach((p, i) => (s.mute[p] = !!(b[3] & (1 << i))));
    s.chords = [b[4] & 15, b[4] >> 4, b[5] & 15, b[5] >> 4].map((d) => (ok.includes(d) ? d : 0));
    for (let i = 0; i < STEPS; i++) s.melody[i] = b[6 + i];
    const row = (v) => (v >= 1 && v <= BASS_ROWS ? v - 1 : -1);
    for (let i = 0; i < 8; i++) {
        s.bass[2 * i] = row(b[22 + i] & 15);
        s.bass[2 * i + 1] = row(b[22 + i] >> 4);
    }
    DRUMS.forEach((part, k) => {
        for (let i = 0; i < 4; i++) {
            for (let j = 0; j < 4; j++) s[part][4 * i + j] = Math.min(2, (b[30 + 4 * k + i] >> (2 * j)) & 3);
        }
    });
    return s;
}
