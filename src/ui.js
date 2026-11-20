// The DOM side: intro, dock, sliders, swatches, toasts, the about card, drag and drop.

const $ = (id) => document.getElementById(id);

/**
 * @param {object} o
 * @param {object} o.settings - persisted settings
 * @param {object} o.scene - scene info for the credits
 * @param {Array} o.palettes
 * @param {object} o.on - handlers
 */
export function createUI({ settings, scene, palettes, on }) {
    const body = document.body;
    body.classList.add('intro-open');

    const intro = $('intro');
    const begin = $('begin');
    const beginLabel = $('beginLabel');
    const loadBar = $('loadBar');
    const play = $('play');
    const playIcon = play.querySelector('use');
    const viz = $('viz');
    const vizCtx = viz.getContext('2d');
    const beatDot = $('beatDot');
    const streaming = $('streaming');
    const toastEl = $('toast');
    const drop = $('drop');
    const info = $('info');
    const fileInput = $('fileInput');
    const intensity = $('intensity');
    const dusk = $('dusk');
    const orbit = $('orbit');
    const swatches = $('swatches');
    const ripples = $('ripples');
    const moodChips = [...document.querySelectorAll('[data-mood]')];
    const studioBtn = $('studioBtn');
    const fileBtn = $('file');
    const micBtn = $('mic');

    // --- credits (CC BY 4.0 asks for title, author, source, licence, and a note of changes) ---
    const link = (href, text) => `<a href="${href}" target="_blank" rel="noopener">${text}</a>`;
    // absolute, so it resolves the same from the dev server and from the built stylesheet
    $('introBg').style.setProperty('--poster', `url("${new URL(scene.poster, document.baseURI).href}")`);
    $('introCredit').innerHTML = `“${link(scene.page, scene.title)}” by ${link(scene.authorPage, scene.author)} · ${link(scene.licenseUrl, scene.license)}`;
    const credit = $('credit');
    credit.href = scene.page;
    credit.textContent = `“${scene.title}” by ${scene.author} · ${scene.license}`;
    $('infoCredit').innerHTML =
        `Scene: “${link(scene.page, scene.title)}” by ${link(scene.authorPage, scene.author)}, ` +
        `${link(scene.licenseUrl, scene.license)}, streamed from SuperSplat. ` +
        'Modified here with audio-reactive effects and generated music. ' +
        `Rendered with ${link('https://playcanvas.com', 'PlayCanvas')}.`;

    // --- swatches -----------------------------------------------------------------------------
    palettes.forEach((p, i) => {
        const b = document.createElement('button');
        b.className = 'swatch';
        b.style.setProperty('--c', p.ui);
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-label', `${p.name} (${i + 1})`);
        b.title = p.name;
        b.dataset.palette = String(i);
        b.addEventListener('click', () => on.palette(i));
        swatches.appendChild(b);
    });

    // --- sliders ------------------------------------------------------------------------------
    const paintSlider = (input) => input.style.setProperty('--p', `${input.value * 100}%`);
    intensity.value = settings.intensity;
    dusk.value = settings.dusk;
    paintSlider(intensity);
    paintSlider(dusk);
    intensity.addEventListener('input', () => {
        paintSlider(intensity);
        on.intensity(+intensity.value);
    });
    dusk.addEventListener('input', () => {
        paintSlider(dusk);
        on.dusk(+dusk.value);
    });

    // --- buttons --------------------------------------------------------------------------------
    begin.addEventListener('click', () => on.begin());
    play.addEventListener('click', () => on.togglePlay());
    moodChips.forEach((c) => c.addEventListener('click', () => on.mood(c.dataset.mood)));
    studioBtn.addEventListener('click', () => on.studio());
    fileBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
        const f = fileInput.files?.[0];
        if (f) on.file(f);
        fileInput.value = '';
    });
    micBtn.addEventListener('click', () => on.mic());
    orbit.addEventListener('click', () => on.orbit());
    $('fullscreen').addEventListener('click', () => on.fullscreen());
    $('infoBtn').addEventListener('click', () => showInfo(true));
    $('infoClose').addEventListener('click', () => showInfo(false));
    info.addEventListener('click', (e) => {
        if (e.target === info) showInfo(false);
    });

    // drag and drop a track anywhere
    let dragDepth = 0;
    const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
    window.addEventListener('dragenter', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        dragDepth++;
        drop.classList.add('show');
    });
    window.addEventListener('dragover', (e) => {
        if (hasFiles(e)) e.preventDefault();
    });
    window.addEventListener('dragleave', () => {
        dragDepth = Math.max(0, dragDepth - 1);
        if (!dragDepth) drop.classList.remove('show');
    });
    window.addEventListener('drop', (e) => {
        e.preventDefault();
        dragDepth = 0;
        drop.classList.remove('show');
        const f = [...(e.dataTransfer?.files ?? [])].find((x) => x.type.startsWith('audio/') || /\.(mp3|wav|ogg|m4a|aac|flac|opus|webm)$/i.test(x.name));
        if (f) on.file(f);
        else if (e.dataTransfer?.files?.length) toast('That isn’t an audio file');
    });

    function showInfo(open) {
        info.hidden = !open;
        if (open) $('infoClose').focus();
    }

    // --- state reflection ---------------------------------------------------------------------
    let accentColor = palettes[settings.palette]?.ui ?? '#ffffff';

    function setAccent(hex) {
        accentColor = hex;
        document.documentElement.style.setProperty('--accent', hex);
        document.documentElement.style.setProperty('--accent-soft', hexToRgba(hex, 0.18));
    }

    function setPalette(i) {
        [...swatches.children].forEach((b, j) => b.setAttribute('aria-checked', String(i === j)));
        setAccent(palettes[i].ui);
    }

    /** @param {number} [bpm] - the studio song's tempo, when mode is 'studio' */
    function setSource(mode, mood, bpm) {
        moodChips.forEach((c) => c.setAttribute('aria-checked', String(mode === 'synth' && c.dataset.mood === mood)));
        studioBtn.setAttribute('aria-checked', String(mode === 'studio'));
        fileBtn.setAttribute('aria-checked', String(mode === 'file'));
        micBtn.setAttribute('aria-checked', String(mode === 'mic'));
        const tempo = mode === 'studio' && bpm ? bpm : { heart: 64, bloom: 116, drift: 56 }[mood] ?? 64;
        document.documentElement.style.setProperty('--beat', `${60 / tempo}s`);
    }

    function setPlaying(playing) {
        play.classList.toggle('playing', playing);
        play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
        play.dataset.tip = playing ? 'Pause · Space' : 'Play · Space';
        playIcon.setAttribute('href', playing ? '#i-pause' : '#i-play');
    }

    function setOrbit(onOff) {
        orbit.setAttribute('aria-pressed', String(onOff));
    }

    function setProgress(p) {
        loadBar.parentElement.style.setProperty('--p', p.toFixed(3));
        loadBar.style.setProperty('--p', p.toFixed(3));
    }

    function waiting() {
        begin.classList.add('waiting');
        beginLabel.textContent = 'Growing…';
    }

    function hideIntro() {
        intro.classList.add('gone');
        loadBar.parentElement.classList.add('done');
        body.classList.remove('intro-open');
        setTimeout(() => intro.remove(), 1600);
    }

    let toastTimer = 0;
    function toast(text, ms = 2600) {
        toastEl.textContent = text;
        toastEl.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
    }

    function ripple(x, y) {
        const i = document.createElement('i');
        i.style.left = `${x}px`;
        i.style.top = `${y}px`;
        ripples.appendChild(i);
        setTimeout(() => i.remove(), 950);
    }

    function setStreaming(onOff) {
        streaming.classList.toggle('on', onOff);
    }

    function toggleHidden(force) {
        body.classList.toggle('ui-hidden', force);
    }

    function fatal(text) {
        const el = $('fatal');
        el.textContent = text;
        el.hidden = false;
    }

    // --- per frame: spectrum and the beat dot ---------------------------------------------------
    const W = viz.width;
    const H = viz.height;
    let beatLevel = 0;

    function frame(bars, beat) {
        beatLevel = beat;
        beatDot.style.setProperty('--b', beat.toFixed(3));
        play.style.setProperty('--b', beat.toFixed(3));

        vizCtx.clearRect(0, 0, W, H);
        vizCtx.fillStyle = accentColor;
        const n = bars.length;
        const gap = 2.4;
        const bw = (W - gap * (n - 1)) / n;
        for (let i = 0; i < n; i++) {
            const v = Math.max(0.06, bars[i]);
            const h = Math.max(bw, v * H);
            const x = i * (bw + gap);
            const y = (H - h) / 2;
            vizCtx.globalAlpha = 0.35 + v * 0.65;
            roundRect(vizCtx, x, y, bw, h, bw / 2);
        }
        vizCtx.globalAlpha = 1;
    }

    return {
        setPalette,
        setSource,
        setPlaying,
        setOrbit,
        setProgress,
        waiting,
        hideIntro,
        toast,
        ripple,
        setStreaming,
        toggleHidden,
        showInfo,
        fatal,
        frame,
        get infoOpen() {
            return !info.hidden;
        },
        get beat() {
            return beatLevel;
        }
    };
}

function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.fill();
}

function hexToRgba(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
