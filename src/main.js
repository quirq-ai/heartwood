import './style.css';

import { Vec3 } from 'playcanvas';

import { AudioEngine } from './audio.js';
import { SCENE, readOverrides } from './config.js';
import { OrbitRig } from './orbit.js';
import { PALETTES, PulseField } from './pulse.js';
import { createStage, loadSplat } from './scene.js';
import { createUI } from './ui.js';

const params = new URLSearchParams(location.search);
const scene = { ...SCENE, ...readOverrides(params) };
const debug = params.has('debug');

// --- settings, remembered per browser ----------------------------------------------------------

const STORE = 'heartwood.settings.v1';
const defaults = { mood: 'heart', palette: 0, intensity: 0.85, dusk: 0.45, orbit: true };
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

const ui = createUI({
    settings,
    scene,
    palettes: PALETTES,
    on: {
        begin: () => beginExperience(),
        togglePlay: () => togglePlay(),
        mood: (m) => chooseMood(m),
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
    window.heartwood = { stage, rig, pulse, audio, heart, eventCounts };
}

// --- flow ------------------------------------------------------------------------------------------

async function beginExperience() {
    if (begun) return;
    begun = true;
    try {
        await audio.init();
        audio.playSynth(settings.mood);
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
    setTimeout(() => ui.toast('Drag to orbit · tap the tree to play', 4200), 2600);
}

function togglePlay() {
    if (!begun) return beginExperience();
    if (audio.playing) {
        audio.pause();
        ui.setPlaying(false);
    } else {
        audio.resume().then(
            () => ui.setPlaying(true),
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

// --- music → light -----------------------------------------------------------------------------------

function onMusic(e) {
    eventCounts[e.type] = (eventCounts[e.type] ?? 0) + 1;
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
        case 'pluck':
            pulse.sparkle = Math.max(pulse.sparkle, 0.35 * e.vel);
            break;
        case 'chime':
            pulse.sparkle = Math.max(pulse.sparkle, 0.9 * e.vel);
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
    audio.tap(Math.max(0, Math.min(1, (p.y - heart.y) / 13)));
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

window.addEventListener('keydown', (e) => {
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
    ui.frame(audio.bars, Math.min(1, pulse.beat));
});
