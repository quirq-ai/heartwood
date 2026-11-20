import './style.css';

import { Vec3 } from 'playcanvas';

import { AudioEngine } from './audio.js';
import { SCENE, readOverrides } from './config.js';
import { OrbitRig } from './orbit.js';
import { PALETTES, PulseField } from './pulse.js';
import { createStage, loadSplat } from './scene.js';
import { MELODY_ROWS, PRESETS, STEPS, clearedSong, decodeSong, encodeSong, generatePart, generateSong } from './song.js';
import { createStudio } from './studio.js';
import { createUI } from './ui.js';

const params = new URLSearchParams(location.search);
const scene = { ...SCENE, ...readOverrides(params) };
const debug = params.has('debug');

// --- settings, remembered per browser ----------------------------------------------------------

const STORE = 'heartwood.settings.v1';
const defaults = { mood: 'heart', palette: 0, intensity: 0.85, dusk: 0.45, orbit: true, studioHint: false };
const settings = { ...defaults, ...readStore() };
if (!PALETTES[settings.palette]) settings.palette = 0;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
if (reducedMotion) settings.orbit = false;

function readStore() {
    try {
        return JSON.parse(localStorage.getItem(STORE) || '{}');
    } catch {
        return {};
    }
}

function saveStore() {
    try {
        localStorage.setItem(STORE, JSON.stringify(settings));
    } catch {
        // private mode or blocked storage: settings just aren't remembered
    }
}

// --- the studio's song ---------------------------------------------------------------------------
// From a shared link (#s=…), else the one last made in this browser, else, on the studio's first
// opening, the song of the mood that is playing.

const SONG_STORE = 'heartwood.song.v1';
const sharedSong = decodeSong(/(?:^#|&)s=([A-Za-z0-9_-]+)/.exec(location.hash)?.[1]);
const storedSong = sharedSong ? null : decodeSong(readSong());
const song = sharedSong ?? storedSong ?? (PRESETS[settings.mood] ?? PRESETS.heart)();
let songMade = !!(sharedSong || storedSong);

function readSong() {
    try {
        return localStorage.getItem(SONG_STORE);
    } catch {
        return null;
    }
}

function saveSong() {
    songMade = true;
    try {
        localStorage.setItem(SONG_STORE, encodeSong(song));
    } catch {
        // not remembered, but still playing
    }
    // once a shared song is changed, it is this browser's song; a reload shouldn't undo that
    if (/(?:^#|&)s=/.test(location.hash)) history.replaceState(null, '', location.pathname + location.search);
}

// undo and redo, as song codes
const past = [];
const future = [];

function remember() {
    past.push(encodeSong(song));
    if (past.length > 80) past.shift();
    future.length = 0;
    studio.setUndo(true);
}

function restore(code) {
    const s = decodeSong(code);
    if (!s) return;
    Object.assign(song, s);
    studio.render();
    saveSong();
}

function undo() {
    if (!past.length) return;
    future.push(encodeSong(song));
    restore(past.pop());
    studio.setUndo(past.length > 0);
}

function redo() {
    if (!future.length) return;
    past.push(encodeSong(song));
    restore(future.pop());
    studio.setUndo(true);
}

// --- audio + ui --------------------------------------------------------------------------------

const audio = new AudioEngine();
let begun = false;
let splatReady = false;
let revealT = -1;
/** @type {PulseField|null} */
let pulse = null;
/** @type {OrbitRig|null} */
let rig = null;
const eventCounts = {};
const touchFirst = matchMedia('(hover: none)').matches;

const ui = createUI({
    settings,
    scene,
    palettes: PALETTES,
    on: {
        begin: () => beginExperience(),
        togglePlay: () => togglePlay(),
        mood: (m) => chooseMood(m),
        studio: () => openStudio(),
        file: (f) => chooseFile(f),
        mic: () => chooseMic(),
        intensity: (v) => {
            settings.intensity = v;
            if (pulse) pulse.targetIntensity = v;
            saveStore();
        },
        dusk: (v) => {
            settings.dusk = v;
            if (pulse) pulse.targetDusk = v;
            saveStore();
        },
        palette: (i) => choosePalette(i),
        orbit: () => setOrbit(!settings.orbit),
        fullscreen: () => toggleFullscreen()
    }
});
ui.setPalette(settings.palette);
ui.setSource('synth', settings.mood);
ui.setOrbit(settings.orbit);

const studio = createStudio({
    song,
    on: {
        play: () => toggleStudioPlay(),
        willChange: () => remember(),
        changed: (kind) => {
            saveSong();
            if (kind === 'tempo' && audio.mode === 'studio') ui.setSource('studio', settings.mood, song.bpm);
        },
        preview: (part, row, value) => audio.preview(part, row, value),
        dice: (part) => {
            remember();
            song[part] = generatePart(part, song);
            song.mute[part] = false;
            studio.render();
            saveSong();
            if (!(audio.mode === 'studio' && audio.playing)) playStudio();
        },
        newSong: (kind) => {
            remember();
            const next = kind === 'blank' ? clearedSong(song) : kind === 'surprise' ? generateSong() : PRESETS[kind]();
            Object.assign(song, next);
            studio.render();
            saveSong();
            playStudio();
        },
        share: () => shareSong(),
        record: () => toggleRecording(),
        undo: () => undo(),
        close: () => closeStudio(),
        armed: (onOff) => {
            if (onOff) ui.toast(touchFirst ? 'Tap the tree to write notes into the melody' : 'Tap the tree or play Z – , to write notes', 3600);
        }
    }
});

// --- stage ---------------------------------------------------------------------------------------

const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('stage'));
let stage;
try {
    stage = await createStage(canvas, { renderer: params.get('renderer') });
} catch (err) {
    ui.fatal('This browser can’t run WebGPU or WebGL 2, which the scene needs.');
    throw err;
}
if (debug) console.info(`[heartwood] renderer: ${stage.rendererName}`);

const heart = new Vec3(...scene.heart);         // trunk base: sway, sparkles and the reveal
const beatOrigin = heart.clone();               // where beat rings start (double-tap moves it)
const heartArr = [heart.x, heart.y, heart.z];
const view = scene.view;
const home = {
    target: new Vec3(heart.x, heart.y + view.lift, heart.z),
    yaw: view.yaw,
    pitch: view.pitch,
    distance: view.distance
};

// the dense-side arc belongs to this scan; another ?src scene gets a plain orbit
const ownScene = scene.url === SCENE.url;

// start close to the trunk, looking up; the camera pulls back as the tree grows around it
rig = new OrbitRig(canvas, stage.camera, {
    target: [home.target.x, home.target.y + 0.6, home.target.z],
    yaw: view.yaw - 32,
    pitch: -16,
    distance: 4.2,
    dip: ownScene ? view.dip : null
});
if (!ownScene) rig.maxDistance = 60;
rig.home = home;
rig.auto = settings.orbit;
rig.enabled = false;

pulse = new PulseField(stage.app.scene.gsplat.material);
pulse.setPalette(settings.palette);
pulse.intensity = pulse.targetIntensity = settings.intensity;
pulse.dusk = pulse.targetDusk = settings.dusk;

loadSplat(stage.app, scene.url, {
    onProgress: (p) => ui.setProgress(p),
    onFirstFrame: () => {
        splatReady = true;
        ui.setProgress(1);
        if (begun) startReveal();
    },
    onStreaming: (n) => ui.setStreaming(n > 0),
    onSettled: () => ui.setStreaming(false),
    onError: (err) => {
        console.error(err);
        ui.fatal('The scene couldn’t be loaded. Check the connection and reload.');
    }
});

// ?debug shows frame stats; it and ?capture expose the internals on window for scripting
if (debug) {
    const { MiniStats } = await import('playcanvas');
    new MiniStats(stage.app);
}
if (debug || params.has('capture')) {
    window.heartwood = { stage, rig, pulse, audio, heart, eventCounts, song, studio };
}

// --- flow ------------------------------------------------------------------------------------------

async function beginExperience() {
    if (begun) return;
    begun = true;
    try {
        await audio.init();
        if (sharedSong) openStudio();
        else audio.playSynth(settings.mood);
        ui.setPlaying(true);
    } catch (err) {
        console.warn('audio unavailable', err);
        ui.toast('Sound is unavailable here');
    }
    if (splatReady) startReveal();
    else ui.waiting();
}

function startReveal() {
    if (revealT >= 0 || !pulse || !rig) return;
    revealT = 0;
    pulse.reveal = 0;
    ui.hideIntro();
    rig.enabled = true;
    rig.goTo(home);
    rig.glide(7);
    rig.touched();
    const hint = sharedSong ? 'A song made here, for you · tap the tree to play along' : 'Drag to orbit · tap the tree to play';
    setTimeout(() => ui.toast(hint, 4200), 2600);
}

function togglePlay() {
    if (!begun) return beginExperience();
    if (audio.playing) {
        audio.pause();
        ui.setPlaying(false);
        studio.setPlaying(false);
    } else {
        audio.resume().then(
            () => {
                ui.setPlaying(true);
                studio.setPlaying(audio.mode === 'studio');
            },
            (err) => {
                console.warn(err);
                ui.toast('Couldn’t resume the sound');
            }
        );
    }
}

function chooseMood(mood) {
    settings.mood = mood;
    saveStore();
    ui.setSource('synth', mood);
    studio.setPlaying(false);
    if (!begun) return;
    if (audio.mode === 'synth' && audio.playing) audio.setMood(mood);
    else audio.playSynth(mood);
    ui.setPlaying(true);
}

async function chooseFile(file) {
    if (!begun) await beginExperience();
    try {
        await audio.playFile(file);
        ui.setSource('file', settings.mood);
        ui.setPlaying(true);
        studio.setPlaying(false);
        ui.toast(audio.fileName ? `♪ ${audio.fileName}` : 'Playing your track');
    } catch (err) {
        console.warn(err);
        ui.toast('That track couldn’t be played');
    }
}

async function chooseMic() {
    if (!begun) await beginExperience();
    try {
        await audio.useMic();
        ui.setSource('mic', settings.mood);
        ui.setPlaying(true);
        studio.setPlaying(false);
        ui.toast('Listening · make some noise');
    } catch (err) {
        console.warn(err);
        ui.toast('The microphone is blocked');
    }
}

function choosePalette(i) {
    settings.palette = i;
    saveStore();
    pulse?.setPalette(i);
    ui.setPalette(i);
}

function setOrbit(onOff) {
    settings.orbit = onOff;
    saveStore();
    if (rig) rig.auto = onOff;
    ui.setOrbit(onOff);
}

function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.().catch(() => {});
}

function resetView() {
    beatOrigin.copy(heart);
    rig.reset();
}

// --- studio ------------------------------------------------------------------------------------------

function openStudio() {
    if (!begun) return;
    // the first time, start from the mood that is playing
    if (!songMade) {
        Object.assign(song, (PRESETS[settings.mood] ?? PRESETS.heart)());
        saveSong();
    }
    studio.open();
    document.body.classList.add('studio-open');
    if (!(audio.mode === 'studio' && audio.playing)) playStudio();
    fitFrame();
    if (!settings.studioHint && !sharedSong) {
        settings.studioHint = true;
        saveStore();
        setTimeout(() => ui.toast('Tap squares to write · the dice make new parts', 4200), 700);
    }
}

function closeStudio() {
    studio.close();
    document.body.classList.remove('studio-open');
    fitFrame();
}

function playStudio() {
    if (!begun || !audio.ready) return;
    audio.playStudio(song);
    ui.setSource('studio', settings.mood, song.bpm);
    ui.setPlaying(true);
    studio.setPlaying(true);
}

function toggleStudioPlay() {
    if (audio.mode === 'studio' && audio.playing) {
        audio.pause();
        ui.setPlaying(false);
        studio.setPlaying(false);
    } else {
        playStudio();
    }
}

/** A melody note played live, from a tap on the tree or a key; written in when the pencil is on. */
function playNote(row, source) {
    const step = audio.live(row, source);
    if (step === null || !studio.armed || !studio.isOpen) return;
    remember();
    song.melody[step] |= 1 << row;
    studio.render();
    saveSong();
}

async function shareSong() {
    const url = `${location.origin}${location.pathname}#s=${encodeSong(song)}`;
    try {
        await navigator.clipboard.writeText(url);
        ui.toast('Link copied · it opens this song');
    } catch {
        history.replaceState(null, '', url);
        ui.toast('The link to this song is in the address bar');
    }
}

let recordedSeconds = -1;

async function toggleRecording() {
    if (audio.recording) {
        const blob = await audio.stopRecording();
        recordedSeconds = -1;
        studio.setRecording(null);
        if (blob) {
            download(blob);
            ui.toast('Recording saved');
        } else {
            ui.toast('Nothing was recorded');
        }
        return;
    }
    try {
        audio.startRecording();
        if (!audio.playing) playStudio();
        recordedSeconds = 0;
        studio.setRecording(0);
        ui.toast('Recording · press again to save it');
    } catch (err) {
        console.warn(err);
        ui.toast('This browser can’t record audio');
    }
}

function download(blob) {
    const ext = blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm';
    const d = new Date();
    const two = (n) => String(n).padStart(2, '0');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `heartwood-${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

// keep the tree centred in the space the studio leaves: beside a side panel, above a sheet
function fitFrame() {
    let x = 0;
    let y = 0;
    if (studio.isOpen) {
        const el = studio.element;
        if (el.offsetLeft > window.innerWidth * 0.45) x = (window.innerWidth - el.offsetLeft) / 2;
        else y = (window.innerHeight - el.offsetTop) / 2;
    }
    rig.frameGoal.x = x;
    rig.frameGoal.y = y;
    document.body.style.setProperty('--studio-w', `${x * 2}px`);
    document.body.style.setProperty('--studio-h', `${y * 2}px`);
}
new ResizeObserver(() => fitFrame()).observe(studio.element);
window.addEventListener('resize', fitFrame);

// --- music → light -----------------------------------------------------------------------------------

/**
 * Where a studio melody note lights the tree: on an upright sheet through the trunk, facing the
 * camera, like a score: left to right through the bar, higher notes higher up.
 */
function scorePoint(step, row) {
    const cam = stage.camera.getPosition();
    const cx = rig.target.x;
    const cz = rig.target.z;
    // the camera's right, along the ground
    let rx = cam.z - cz;
    let rz = cx - cam.x;
    const len = Math.hypot(rx, rz) || 1;
    rx /= len;
    rz /= len;
    const across = ((step + 0.5) / STEPS - 0.5) * Math.min(9, rig.distance * 0.8);
    return [cx + rx * across, heart.y + 2 + row * 0.85, cz + rz * across];
}

let lastBassRing = -1;

function onMusic(e) {
    eventCounts[e.type] = (eventCounts[e.type] ?? 0) + 1;
    if (e.part || e.type === 'step') studio.onEvent(e);
    switch (e.type) {
        case 'kick':
            pulse.ring(beatOrigin, { amp: 0.95 * e.vel, speed: 7.5, width: 0.6 });
            pulse.beat = Math.max(pulse.beat, e.vel);
            break;
        case 'dub':
            pulse.ring(beatOrigin, { amp: 0.5 * e.vel, speed: 7.5, width: 0.5 });
            pulse.beat = Math.max(pulse.beat, 0.55 * e.vel);
            break;
        case 'chord':
            pulse.ring(beatOrigin, { amp: 0.45, speed: 3.4, width: 1.2 });
            break;
        case 'swell':
            pulse.ring(beatOrigin, { amp: 0.7, speed: 4.2, width: 1.2 });
            pulse.beat = Math.max(pulse.beat, 0.6);
            break;
        case 'clap':
            pulse.beat = Math.max(pulse.beat, 0.35);
            break;
        case 'hat':
            pulse.sparkle = Math.max(pulse.sparkle, 0.32 * e.vel);
            break;
        case 'bass': {
            // the bass hums along the ground: slower and wider than the heart, in the second
            // colour, stronger the longer the note; a fast run lights only every so often, or its
            // rings would merge into one sheet of light
            if (pulse.time - lastBassRing < 0.55) break;
            lastBassRing = pulse.time;
            const hold = Math.min(1, (e.len ?? 4) / 6);
            pulse.ring(beatOrigin, { amp: (0.2 + 0.42 * hold) * e.vel, speed: 4.4, width: 0.9 + 0.6 * hold, tint: 1, life: 3.2 });
            break;
        }
        case 'pluck':
        case 'chime':
            pulse.sparkle = Math.max(pulse.sparkle, (e.type === 'chime' ? 0.9 : 0.35) * e.vel);
            // a studio melody is written into the canopy as it plays (a tap lights its own spot)
            if (e.part === 'melody' && e.live !== 'tap' && !e.preview) {
                pulse.ring(scorePoint(e.step ?? 7.5, e.row), { amp: 0.5 + 0.35 * e.vel, speed: 1.5, width: 0.42, shape: 1, tint: 2, life: 1.5 });
            }
            break;
    }
}

// --- taps --------------------------------------------------------------------------------------------

async function pointAt(x, y) {
    try {
        const p = await stage.pick(x, y);
        if (p) return p;
    } catch (err) {
        if (debug) console.warn('pick failed', err);
    }
    return stage.rayToPlane(x, y, heart.y);
}

rig.onTap = async (x, y) => {
    if (revealT < 0) return;
    ui.ripple(x, y);
    const p = await pointAt(x, y);
    if (!p) return;
    if (debug) console.info('[heartwood] tap', p.x.toFixed(2), p.y.toFixed(2), p.z.toFixed(2));
    pulse.ring(p, { amp: 1.3, speed: 5.2, width: 0.75, shape: 1 });
    const height = Math.max(0, Math.min(1, (p.y - heart.y) / 13));
    // in the studio a tap plays the song's melody sound, in its key: higher in the tree, higher note
    if (audio.mode === 'studio') playNote(Math.round(height * (MELODY_ROWS - 1)), 'tap');
    else audio.tap(height);
};

rig.onDoubleTap = async (x, y) => {
    if (revealT < 0) return;
    const p = await pointAt(x, y);
    if (!p) return;
    beatOrigin.copy(p);
    rig.goTo({ target: p });
    pulse.ring(p, { amp: 1.6, speed: 6, width: 1.1 });
    ui.toast('The heart moved · R to reset');
};

// --- keys ------------------------------------------------------------------------------------------

// the bottom row of the keyboard plays the melody's eight notes, low to high
const NOTE_KEYS = ['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM', 'Comma'];

window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && studio.isOpen && (e.code === 'KeyZ' || e.code === 'KeyY')) {
        e.preventDefault();
        if (e.code === 'KeyY' || e.shiftKey) redo();
        else undo();
        return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target instanceof HTMLInputElement && e.target.type !== 'range') return;
    if (ui.infoOpen && e.code === 'Escape') return ui.showInfo(false);
    if (document.body.classList.contains('intro-open')) {
        if (e.code === 'Enter' || e.code === 'Space') {
            e.preventDefault();
            beginExperience();
        }
        return;
    }
    if (e.code === 'Escape' && studio.isOpen) {
        if (!studio.dismiss()) closeStudio();
        return;
    }
    const note = NOTE_KEYS.indexOf(e.code);
    if (note >= 0 && audio.mode === 'studio') {
        if (!e.repeat) playNote(note, 'key');
        return;
    }
    switch (e.code) {
        case 'Space':
            e.preventDefault();
            togglePlay();
            break;
        case 'Digit1':
        case 'Digit2':
        case 'Digit3':
        case 'Digit4':
            choosePalette(+e.code.slice(-1) - 1);
            break;
        case 'KeyH':
            ui.toggleHidden();
            break;
        case 'KeyF':
            toggleFullscreen();
            break;
        case 'KeyO':
            setOrbit(!settings.orbit);
            break;
        case 'KeyR':
            resetView();
            break;
        case 'KeyP':
            pulse.ring(beatOrigin, { amp: 1.4, speed: 6.5, width: 1.1 });
            pulse.beat = 1;
            break;
        default:
            if (rig.key(e.code)) e.preventDefault();
    }
});

// pause the sound with the tab, pick it up again on return
document.addEventListener('visibilitychange', () => {
    if (!audio.ctx) return;
    if (document.hidden) {
        if (audio.mode === 'file') audio.audioEl?.pause();
        audio.ctx.suspend();
    } else {
        audio.ctx.resume();
        if (audio.mode === 'file' && audio.playing) audio.audioEl?.play().catch(() => {});
    }
});

// --- frame loop ----------------------------------------------------------------------------------------

const REVEAL_SECONDS = 5.5;
const REVEAL_RADIUS = 46;
const easeOut = (t) => 1 - Math.pow(1 - t, 3);

// if the device can't keep up, trade splats and pixels for frame rate
let slow = 0;
const MIN_BUDGET = 6e5;
function governQuality(dt) {
    if (revealT < REVEAL_SECONDS) return;
    slow = dt > 1 / 28 ? slow + dt : Math.max(0, slow - dt * 0.5);
    if (slow < 4) return;
    slow = 0;
    const gs = stage.app.scene.gsplat;
    const device = stage.device;
    if (gs.splatBudget > MIN_BUDGET) {
        gs.splatBudget = Math.max(MIN_BUDGET, Math.round(gs.splatBudget * 0.7));
    } else if (device.maxPixelRatio > 0.75) {
        device.maxPixelRatio = Math.max(0.75, device.maxPixelRatio * 0.85);
        stage.app.resizeCanvas();
    }
    if (debug) console.info('[heartwood] quality down', gs.splatBudget, device.maxPixelRatio.toFixed(2));
}

stage.app.on('update', (dt) => {
    governQuality(dt);
    const levels = audio.analyse(dt);
    for (const e of audio.drainEvents()) onMusic(e);

    if (revealT >= 0 && revealT < REVEAL_SECONDS) {
        revealT += dt;
        pulse.reveal = revealT >= REVEAL_SECONDS ? 1e5 : easeOut(revealT / REVEAL_SECONDS) * REVEAL_RADIUS;
    }

    rig.update(dt);
    pulse.setView(stage.camera.getPosition(), rig.clearRadius);
    pulse.update(dt, levels, heartArr);
    const beat = Math.min(1, pulse.beat);
    ui.frame(audio.bars, beat);
    studio.frame(beat);

    if (audio.recording) {
        const seconds = Math.floor((performance.now() - audio.recStart) / 1000);
        if (seconds !== recordedSeconds) {
            recordedSeconds = seconds;
            studio.setRecording(seconds);
        }
    }
});
