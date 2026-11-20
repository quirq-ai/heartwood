// The studio: a step sequencer for the song the tree plays. Each part is one bar of sixteen
// steps, looped under four bars of chords. Tap a square to write, drag to paint, tap a part's
// name to mute it, its dice for a new one. Squares light as they sound.

import { BASS_ROWS, MELODY_ROWS, NOTE_NAMES, SCALES, STEPS, chordName, fitChords, keyName } from './song.js';

const $ = (id) => document.getElementById(id);

const LANES = [
    { part: 'chords', name: 'Chords' },
    { part: 'melody', name: 'Melody', rows: MELODY_ROWS },
    { part: 'bass', name: 'Bass', rows: BASS_ROWS },
    { part: 'heart', name: 'Heart', rows: 1, drum: true },
    { part: 'clap', name: 'Clap', rows: 1, drum: true },
    { part: 'hats', name: 'Hats', rows: 1, drum: true }
];

const NEW_SONGS = [
    ['surprise', 'Surprise me'],
    ['heart', 'Heart'],
    ['bloom', 'Bloom'],
    ['drift', 'Drift'],
    ['blank', 'Blank']
];

function button(cls, text, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    if (text) b.textContent = text;
    if (onClick) b.addEventListener('click', onClick);
    return b;
}

function icon(name) {
    return `<svg class="ic sm"><use href="#${name}" /></svg>`;
}

/**
 * @param {object} o
 * @param {object} o.song - the song, edited in place
 * @param {object} o.on - handlers: play, willChange, changed(kind), preview(part, row, value),
 *   dice(part), newSong(kind), share, record, undo, close, armed(onOff)
 */
export function createStudio({ song, on }) {
    const panel = $('studio');
    const lanesEl = $('stLanes');
    const pop = $('stPop');
    const playBtn = $('stPlay');
    const playIcon = playBtn.querySelector('use');
    const bpmEl = $('stBpm');
    const keyBtn = $('stKey');
    const undoBtn = $('stUndo');
    const newBtn = $('stNew');
    const recBtn = $('stRec');
    const recTime = $('stRecTime');

    let open = false;
    let armed = false;
    let nowStep = -1;
    let nowBar = -1;

    // --- lanes ----------------------------------------------------------------------------------

    const cells = {};                                          // part → [row][step] → square
    const columns = Array.from({ length: STEPS }, () => []);   // step → every square in it
    const laneEls = {};
    const nameBtns = {};
    let chordBtns = [];
    let leadBtn = null;
    let armBtn = null;

    for (const lane of LANES) {
        const el = document.createElement('div');
        el.className = `lane lane-${lane.part}${lane.drum ? ' lane-drum' : ''}`;
        const side = document.createElement('div');
        side.className = 'lane-side';
        const name = button('lane-name', lane.name, () => toggleMute(lane.part));
        name.setAttribute('aria-pressed', 'true');
        name.title = `Mute ${lane.name.toLowerCase()}`;
        side.appendChild(name);
        nameBtns[lane.part] = name;

        if (lane.part === 'melody') {
            leadBtn = button('lane-opt', 'Pluck', () => {
                on.willChange();
                song.lead = song.lead === 'bell' ? 'pluck' : 'bell';
                render();
                on.preview('melody', 5, 1);
                on.changed('lead');
            });
            leadBtn.title = 'The melody’s sound';
            armBtn = button('lane-arm', '', () => setArmed(!armed));
            armBtn.innerHTML = icon('i-pencil');
            armBtn.setAttribute('aria-pressed', 'false');
            armBtn.setAttribute('aria-label', 'Write the notes you play into the melody');
            armBtn.title = 'Write what you play';
            const opts = document.createElement('div');
            opts.className = 'lane-opts';
            opts.append(leadBtn, armBtn);
            side.appendChild(opts);
        }
        el.appendChild(side);

        let body;
        if (lane.part === 'chords') {
            body = document.createElement('div');
            body.className = 'chords';
            chordBtns = [0, 1, 2, 3].map((bar) => {
                const b = button('chord', '', () => stepChord(bar, 1));
                b.title = `Bar ${bar + 1}: tap for the next chord, right-click for the one before`;
                b.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    stepChord(bar, -1);
                });
                body.appendChild(b);
                return b;
            });
        } else {
            body = document.createElement('div');
            body.className = 'cells';
            cells[lane.part] = [];
            // the highest row on top
            for (let row = lane.rows - 1; row >= 0; row--) {
                cells[lane.part][row] = [];
                for (let step = 0; step < STEPS; step++) {
                    const c = button(`cell${Math.floor(step / 4) % 2 ? ' alt' : ''}`);
                    c.tabIndex = -1;
                    c.dataset.part = lane.part;
                    c.dataset.step = String(step);
                    c.dataset.row = String(row);
                    c.setAttribute('aria-label', `${lane.name}, step ${step + 1}${lane.rows > 1 ? `, row ${row + 1}` : ''}`);
                    body.appendChild(c);
                    cells[lane.part][row][step] = c;
                    columns[step].push(c);
                }
            }
        }
        el.appendChild(body);

        const dice = button('lane-dice', '', () => on.dice(lane.part));
        dice.innerHTML = icon('i-dice');
        dice.setAttribute('aria-label', `New ${lane.name.toLowerCase()}`);
        dice.title = `New ${lane.name.toLowerCase()}`;
        el.appendChild(dice);

        lanesEl.appendChild(el);
        laneEls[lane.part] = el;
    }

    // --- writing: tap a square, or drag across a lane to paint ------------------------------------

    let paint = null;

    lanesEl.addEventListener('pointerdown', (e) => {
        const c = e.target.closest?.('.cell');
        if (!c || e.button > 0) return;
        e.preventDefault();
        const part = c.dataset.part;
        const step = +c.dataset.step;
        const row = +c.dataset.row;
        on.willChange();
        let value;
        if (part === 'melody') value = !(song.melody[step] & (1 << row));
        else if (part === 'bass') value = song.bass[step] === row ? -1 : row;
        else value = [2, 0, 1][song[part][step]];     // off → full → soft → off
        paint = { part, value, id: e.pointerId, last: c };
        try {
            lanesEl.setPointerCapture(e.pointerId);
        } catch {
            // painting still works square by square
        }
        apply(part, step, row, value);
    });

    lanesEl.addEventListener('pointermove', (e) => {
        if (!paint || e.pointerId !== paint.id) return;
        const c = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.cell');
        if (!c || c === paint.last || c.dataset.part !== paint.part) return;
        paint.last = c;
        apply(paint.part, +c.dataset.step, +c.dataset.row, paint.value);
    });

    const endPaint = (e) => {
        if (!paint || e.pointerId !== paint.id) return;
        paint = null;
        on.changed('notes');
    };
    lanesEl.addEventListener('pointerup', endPaint);
    lanesEl.addEventListener('pointercancel', endPaint);
    lanesEl.addEventListener('contextmenu', (e) => {
        if (e.target.closest?.('.cell')) e.preventDefault();
    });

    function apply(part, step, row, value) {
        let sounds = false;
        if (part === 'melody') {
            if (value) song.melody[step] |= 1 << row;
            else song.melody[step] &= ~(1 << row);
            sounds = !!value;
        } else if (part === 'bass') {
            if (value === -1) {
                if (song.bass[step] === row) song.bass[step] = -1;
            } else {
                song.bass[step] = row;
                sounds = true;
            }
        } else {
            song[part][step] = value;
            sounds = value > 0;
        }
        renderPart(part);
        if (sounds) on.preview(part, row, part === 'melody' || part === 'bass' ? 1 : value);
    }

    function stepChord(bar, dir) {
        const opts = SCALES[song.scale].chords;
        const i = Math.max(0, opts.indexOf(song.chords[bar]));
        on.willChange();
        song.chords[bar] = opts[(i + dir + opts.length) % opts.length];
        renderChords();
        on.preview('chords', song.chords[bar], 1);
        on.changed('chords');
    }

    function toggleMute(part) {
        on.willChange();
        song.mute[part] = !song.mute[part];
        renderMutes();
        on.changed('mute');
    }

    function setArmed(onOff) {
        armed = onOff;
        armBtn.setAttribute('aria-pressed', String(onOff));
        on.armed?.(onOff);
    }

    // --- the header ----------------------------------------------------------------------------------

    playBtn.addEventListener('click', () => on.play());
    $('stShare').addEventListener('click', () => on.share());
    recBtn.addEventListener('click', () => on.record());
    undoBtn.addEventListener('click', () => on.undo());
    $('stClose').addEventListener('click', () => on.close());

    // tempo: press and hold to keep going
    const nudge = (dir) => {
        song.bpm = Math.max(40, Math.min(200, song.bpm + dir));
        bpmEl.textContent = String(song.bpm);
        on.changed('tempo');
    };
    holdToRepeat($('stSlower'), () => nudge(-1));
    holdToRepeat($('stFaster'), () => nudge(1));

    function holdToRepeat(btn, fn) {
        let timer = 0;
        const stop = () => {
            clearTimeout(timer);
            clearInterval(timer);
            timer = 0;
        };
        btn.addEventListener('pointerdown', (e) => {
            if (e.button > 0) return;
            e.preventDefault();
            on.willChange();
            fn();
            stop();
            timer = setTimeout(() => (timer = setInterval(fn, 60)), 380);
        });
        ['pointerup', 'pointerleave', 'pointercancel'].forEach((t) => btn.addEventListener(t, stop));
        // keyboard presses arrive as clicks with no pointer behind them
        btn.addEventListener('click', (e) => {
            if (e.detail !== 0) return;
            on.willChange();
            fn();
        });
    }

    // --- popovers: the key, and new songs -------------------------------------------------------------

    let popFor = null;

    keyBtn.addEventListener('click', () => (popFor === 'key' ? closePop() : openKeyPop()));
    newBtn.addEventListener('click', () => (popFor === 'new' ? closePop() : openNewPop()));

    function openKeyPop() {
        pop.replaceChildren();
        const roots = document.createElement('div');
        roots.className = 'pop-keys';
        NOTE_NAMES.forEach((n, pc) => {
            const b = button('pop-key', n, () => {
                on.willChange();
                song.root = pc;
                render();
                openKeyPop();
                on.preview('chords', song.chords[0], 1);
                on.changed('key');
            });
            b.setAttribute('role', 'radio');
            b.setAttribute('aria-checked', String(pc === song.root));
            roots.appendChild(b);
        });
        const scales = document.createElement('div');
        scales.className = 'pop-scales';
        for (const sc of ['minor', 'major']) {
            const b = button('chip', sc, () => {
                if (song.scale === sc) return;
                on.willChange();
                song.scale = sc;
                fitChords(song);
                render();
                openKeyPop();
                on.preview('chords', song.chords[0], 1);
                on.changed('key');
            });
            b.setAttribute('role', 'radio');
            b.setAttribute('aria-checked', String(song.scale === sc));
            scales.appendChild(b);
        }
        pop.append(roots, scales);
        showPop(keyBtn, 'key');
    }

    function openNewPop() {
        pop.replaceChildren();
        const menu = document.createElement('div');
        menu.className = 'pop-menu';
        for (const [kind, label] of NEW_SONGS) {
            menu.appendChild(button('pop-item', label, () => {
                closePop();
                on.newSong(kind);
            }));
        }
        pop.appendChild(menu);
        showPop(newBtn, 'new');
    }

    function showPop(anchor, name) {
        popFor = name;
        pop.hidden = false;
        keyBtn.setAttribute('aria-expanded', String(name === 'key'));
        newBtn.setAttribute('aria-expanded', String(name === 'new'));
        const left = Math.min(anchor.offsetLeft, panel.clientWidth - pop.offsetWidth - 10);
        pop.style.left = `${Math.max(10, left)}px`;
        pop.style.top = `${anchor.offsetTop + anchor.offsetHeight + 6}px`;
    }

    function closePop() {
        popFor = null;
        pop.hidden = true;
        keyBtn.setAttribute('aria-expanded', 'false');
        newBtn.setAttribute('aria-expanded', 'false');
    }

    document.addEventListener('pointerdown', (e) => {
        if (pop.hidden) return;
        if (pop.contains(e.target) || keyBtn.contains(e.target) || newBtn.contains(e.target)) return;
        closePop();
    });

    // --- drawing ------------------------------------------------------------------------------------

    function setCell(c, isOn, soft) {
        c.classList.toggle('on', isOn);
        c.classList.toggle('soft', isOn && soft);
        c.setAttribute('aria-pressed', String(isOn));
    }

    function renderPart(part) {
        const grid = cells[part];
        if (!grid) return;
        for (let s = 0; s < STEPS; s++) {
            if (part === 'melody') {
                for (let row = 0; row < MELODY_ROWS; row++) setCell(grid[row][s], !!(song.melody[s] & (1 << row)), false);
            } else if (part === 'bass') {
                for (let row = 0; row < BASS_ROWS; row++) setCell(grid[row][s], song.bass[s] === row, false);
            } else {
                setCell(grid[0][s], song[part][s] > 0, song[part][s] === 1);
            }
        }
    }

    function renderChords() {
        chordBtns.forEach((b, bar) => (b.textContent = chordName(song, song.chords[bar])));
    }

    function renderMutes() {
        for (const lane of LANES) {
            const muted = !!song.mute[lane.part];
            nameBtns[lane.part].setAttribute('aria-pressed', String(!muted));
            nameBtns[lane.part].title = `${muted ? 'Unmute' : 'Mute'} ${lane.name.toLowerCase()}`;
            laneEls[lane.part].classList.toggle('muted', muted);
        }
    }

    function render() {
        bpmEl.textContent = String(song.bpm);
        keyBtn.textContent = keyName(song);
        leadBtn.textContent = song.lead === 'bell' ? 'Bell' : 'Pluck';
        for (const lane of LANES) renderPart(lane.part);
        renderChords();
        renderMutes();
    }

    /** Moves the playhead; -1 clears it. */
    function setStep(step, bar) {
        if (step !== nowStep) {
            if (nowStep >= 0) for (const c of columns[nowStep]) c.classList.remove('now');
            nowStep = step;
            if (step >= 0) for (const c of columns[step]) c.classList.add('now');
        }
        if (bar !== nowBar) {
            nowBar = bar;
            chordBtns.forEach((b, i) => b.classList.toggle('now', i === bar));
        }
    }

    function flash(el) {
        el?.animate?.(
            [
                { transform: 'scale(1.4)', filter: 'brightness(2)' },
                { transform: 'scale(1)', filter: 'brightness(1)' }
            ],
            { duration: 300, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' }
        );
    }

    /** Music events from the sequencer, at the moment they are heard. */
    function onEvent(e) {
        if (!open) return;
        if (e.type === 'step') {
            setStep(e.step, e.bar);
            return;
        }
        if (e.preview || e.live) return;
        if (e.part === 'chords') {
            flash(chordBtns[e.bar]);
            return;
        }
        if (e.step === undefined) return;
        flash(cells[e.part]?.[e.row ?? 0]?.[e.step]);
    }

    function setPlaying(playing) {
        playBtn.classList.toggle('playing', playing);
        playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
        playIcon.setAttribute('href', playing ? '#i-pause' : '#i-play');
        if (!playing) setStep(-1, -1);
    }

    /** Seconds recorded so far, or null when not recording. */
    function setRecording(seconds) {
        const rec = typeof seconds === 'number';
        recBtn.setAttribute('aria-pressed', String(rec));
        recBtn.setAttribute('aria-label', rec ? 'Stop recording and save' : 'Record');
        recBtn.dataset.tip = rec ? 'Stop and save' : 'Record';
        recTime.textContent = rec ? `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}` : '';
    }

    function setUndo(can) {
        undoBtn.disabled = !can;
    }

    function show() {
        if (open) return;
        open = true;
        panel.hidden = false;
        render();
    }

    function hide() {
        if (!open) return;
        open = false;
        closePop();
        setStep(-1, -1);
        panel.hidden = true;
    }

    function frame(beat) {
        if (open) playBtn.style.setProperty('--b', beat.toFixed(3));
    }

    render();

    return {
        open: show,
        close: hide,
        render,
        setPlaying,
        setRecording,
        setUndo,
        onEvent,
        frame,
        /** Closes an open popover; true if there was one. */
        dismiss() {
            if (pop.hidden) return false;
            closePop();
            return true;
        },
        get isOpen() {
            return open;
        },
        get armed() {
            return armed;
        },
        get element() {
            return panel;
        }
    };
}
