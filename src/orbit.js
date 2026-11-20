import { Vec3 } from 'playcanvas';

// A small orbit camera: drag to orbit, right-drag or two fingers to pan, wheel or pinch to zoom,
// taps reported separately. Everything is damped, and the camera drifts around on its own when
// left alone.

const DEG = Math.PI / 180;
const damp = (current, goal, rate, dt) => current + (goal - current) * (1 - Math.exp(-rate * dt));
const smoothstep = (a, b, x) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
};

export class OrbitRig {
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {import('playcanvas').Entity} camera
     */
    constructor(canvas, camera, { target, yaw, pitch, distance, dip = null }) {
        this.canvas = canvas;
        this.camera = camera;
        // { yaw, inner, outer, to }: an arc where the drifting camera moves in to `to` metres
        this.dip = dip;
        this.dipFactor = 0;
        this.viewDistance = distance;

        this.target = new Vec3(...target);
        this.targetGoal = this.target.clone();
        this.yaw = this.yawGoal = yaw;
        this.pitch = this.pitchGoal = pitch;
        this.distance = this.distanceGoal = distance;
        this.home = { target: this.target.clone(), yaw, pitch, distance };

        this.minDistance = 1.5;
        this.maxDistance = 24;
        this.minPitch = -38;
        this.maxPitch = 60;

        // the space around the camera kept clear of anything above the ground (done in the splat
        // shader, so foliage between the camera and the tree goes but the ground stays)
        this.clearRatio = 0.5;
        this.maxClear = 11;
        this.clearRadius = 0;
        camera.camera.nearClip = 0.12;

        // damping rates, and the gentler ones of a scripted glide
        this.rates = { angle: 9, distance: 6, target: 5 };
        this.glideRates = { angle: 0.75, distance: 0.7, target: 0.9 };
        this.glideTime = 0;

        this.auto = true;           // drift around when idle
        this.autoSpeed = 4.5;       // degrees per second
        this.idleDelay = 3.5;       // seconds after input before drifting again
        this.idle = 99;
        this.autoBlend = 0;         // 0..1, eases the drift's gentle bob in and out
        this.clock = 0;
        this.yawVelocity = 0;       // inertia after a flick

        this.onTap = null;
        this.onDoubleTap = null;
        this.enabled = true;

        this.pointers = new Map();
        this.gesture = null;
        this.lastTap = { time: 0, x: 0, y: 0 };

        this._right = new Vec3();
        this._up = new Vec3();
        this._pos = new Vec3();

        canvas.addEventListener('pointerdown', this.onPointerDown);
        canvas.addEventListener('pointermove', this.onPointerMove);
        canvas.addEventListener('pointerup', this.onPointerUp);
        canvas.addEventListener('pointercancel', this.onPointerUp);
        canvas.addEventListener('wheel', this.onWheel, { passive: false });
        canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    /** Moves the orbit smoothly to a new pose (any field may be left out). */
    goTo({ target, yaw, pitch, distance } = {}) {
        if (target) this.targetGoal.copy(target);
        if (yaw !== undefined) {
            // take the short way round
            const delta = ((yaw - this.yawGoal + 540) % 360) - 180;
            this.yawGoal += delta;
        }
        if (pitch !== undefined) this.pitchGoal = pitch;
        if (distance !== undefined) this.distanceGoal = distance;
    }

    /** Jumps to a pose without easing. */
    snap({ target, yaw, pitch, distance }) {
        if (target) {
            this.target.copy(target);
            this.targetGoal.copy(target);
        }
        if (yaw !== undefined) this.yaw = this.yawGoal = yaw;
        if (pitch !== undefined) this.pitch = this.pitchGoal = pitch;
        if (distance !== undefined) this.distance = this.distanceGoal = distance;
    }

    reset() {
        this.goTo(this.home);
        this.idle = 0;
    }

    /** Eases slowly to the current goals for a while; any input takes over at once. */
    glide(seconds = 6) {
        this.glideTime = seconds;
    }

    touched() {
        this.idle = 0;
    }

    update(dt) {
        dt = Math.min(dt, 0.1);
        this.idle += dt;
        this.clock += dt;

        const drifting = this.auto && this.idle > this.idleDelay && !this.gesture;
        if (drifting) {
            const ramp = Math.min(1, (this.idle - this.idleDelay) / 3);
            this.yawGoal += this.autoSpeed * ramp * dt;
        }
        this.autoBlend = damp(this.autoBlend, drifting ? 1 : 0, drifting ? 0.5 : 4, dt);

        if (!this.gesture && Math.abs(this.yawVelocity) > 0.01) {
            this.yawGoal += this.yawVelocity * dt;
            this.yawVelocity *= Math.exp(-dt * 3.5);
        }

        this.pitchGoal = Math.min(this.maxPitch, Math.max(this.minPitch, this.pitchGoal));
        this.distanceGoal = Math.min(this.maxDistance, Math.max(this.minDistance, this.distanceGoal));

        if (this.glideTime > 0) this.glideTime -= dt;
        const r = this.glideTime > 0 ? this.glideRates : this.rates;
        this.yaw = damp(this.yaw, this.yawGoal, r.angle, dt);
        this.pitch = damp(this.pitch, this.pitchGoal, r.angle, dt);
        this.distance = damp(this.distance, this.distanceGoal, r.distance, dt);
        this.target.x = damp(this.target.x, this.targetGoal.x, r.target, dt);
        this.target.y = damp(this.target.y, this.targetGoal.y, r.target, dt);
        this.target.z = damp(this.target.z, this.targetGoal.z, r.target, dt);

        // round the dense side of the scene, the drifting camera moves in under the branches
        if (this.dip) {
            const delta = Math.abs(((((this.yaw - this.dip.yaw) % 360) + 540) % 360) - 180);
            const inArc = 1 - smoothstep(this.dip.inner, this.dip.outer, delta);
            this.dipFactor = damp(this.dipFactor, drifting ? inArc : 0, 1.2, dt);
        }
        const near = Math.min(this.distance, this.dip?.to ?? this.distance);
        this.viewDistance = this.distance + (near - this.distance) * this.dipFactor;

        // while drifting, the camera also bobs a little, like a slow breath
        const bob = this.autoBlend;
        const pitch = this.pitch + bob * 2.5 * Math.sin(this.clock * 0.21);
        const distance = this.viewDistance * (1 + bob * 0.05 * Math.sin(this.clock * 0.13 + 1.3));
        this.clearRadius = Math.min(this.maxClear, distance * this.clearRatio);

        const cp = Math.cos(pitch * DEG);
        this._pos.set(
            Math.sin(this.yaw * DEG) * cp,
            Math.sin(pitch * DEG),
            Math.cos(this.yaw * DEG) * cp
        ).mulScalar(distance).add(this.target);

        this.camera.setPosition(this._pos);
        this.camera.lookAt(this.target);
    }

    /** Takes over the distance the drift had moved in to, so user input doesn't jump it back. */
    commitView() {
        if (this.dipFactor > 0.001) {
            this.distance = this.distanceGoal = this.viewDistance;
            this.dipFactor = 0;
        }
    }

    // --- input -----------------------------------------------------------------------------

    onPointerDown = (e) => {
        if (!this.enabled) return;
        try {
            this.canvas.setPointerCapture(e.pointerId);
        } catch {
            // synthetic or already-released pointers can't be captured; dragging still works
        }
        this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: performance.now(), button: e.button });
        this.yawVelocity = 0;
        this.idle = 0;
        this.glideTime = 0;
        this.commitView();

        if (this.pointers.size === 1) {
            const pan = e.button === 2 || e.button === 1 || e.shiftKey;
            this.gesture = { kind: pan ? 'pan' : 'orbit', moved: false, multi: false };
        } else if (this.pointers.size === 2) {
            const [a, b] = [...this.pointers.values()];
            this.gesture = {
                kind: 'pinch',
                moved: true,
                multi: true,
                dist: Math.hypot(a.x - b.x, a.y - b.y),
                cx: (a.x + b.x) / 2,
                cy: (a.y + b.y) / 2
            };
        }
        this.canvas.classList.add('dragging');
    };

    onPointerMove = (e) => {
        const p = this.pointers.get(e.pointerId);
        if (!p || !this.gesture) return;
        const dx = e.clientX - p.x;
        const dy = e.clientY - p.y;
        p.x = e.clientX;
        p.y = e.clientY;
        this.idle = 0;

        const g = this.gesture;
        if (!g.moved && Math.hypot(p.x - p.sx, p.y - p.sy) > 6) g.moved = true;
        if (!g.moved) return;

        if (g.kind === 'orbit') {
            const k = 0.28;
            this.yawGoal -= dx * k;
            this.pitchGoal += dy * k * 0.8;
            // remember the last ~100 ms of movement to give a flick its momentum
            const now = performance.now();
            g.samples ??= [];
            g.samples.push([now, this.yawGoal]);
            while (g.samples.length > 2 && now - g.samples[0][0] > 100) g.samples.shift();
        } else if (g.kind === 'pan') {
            this.pan(dx, dy);
        } else if (g.kind === 'pinch' && this.pointers.size >= 2) {
            const [a, b] = [...this.pointers.values()];
            const dist = Math.hypot(a.x - b.x, a.y - b.y);
            const cx = (a.x + b.x) / 2;
            const cy = (a.y + b.y) / 2;
            if (g.dist > 0 && dist > 0) this.distanceGoal *= g.dist / dist;
            this.pan(cx - g.cx, cy - g.cy);
            g.dist = dist;
            g.cx = cx;
            g.cy = cy;
        }
    };

    onPointerUp = (e) => {
        const p = this.pointers.get(e.pointerId);
        this.pointers.delete(e.pointerId);
        try {
            if (this.canvas.hasPointerCapture?.(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
        } catch {
            // nothing to release
        }
        const g = this.gesture;

        if (this.pointers.size === 0) {
            this.canvas.classList.remove('dragging');
            this.gesture = null;
            if (g && !g.moved && !g.multi && p && e.type === 'pointerup' && p.button === 0) {
                if (performance.now() - p.t < 450) this.tap(e);
            }
            this.yawVelocity = 0;
            const s = g?.kind === 'orbit' && g.moved ? g.samples : null;
            if (s && s.length > 1) {
                const [t0, y0] = s[0];
                const [t1, y1] = s[s.length - 1];
                const span = (t1 - t0) / 1000;
                // only a release while still moving keeps spinning
                if (span > 0.02 && performance.now() - t1 < 60) {
                    this.yawVelocity = Math.max(-300, Math.min(300, ((y1 - y0) / span) * 0.6));
                }
            }
        } else if (this.pointers.size === 1) {
            // a finger lifted mid-pinch: carry on orbiting with the other one, but never tap
            this.gesture = { kind: 'orbit', moved: true, multi: true };
        }
    };

    onWheel = (e) => {
        if (!this.enabled) return;
        e.preventDefault();
        this.commitView();
        const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
        this.distanceGoal *= Math.exp(Math.max(-200, Math.min(200, delta)) * 0.0012);
        this.idle = 0;
        this.glideTime = 0;
    };

    tap(e) {
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const now = performance.now();
        const last = this.lastTap;
        const double = now - last.time < 320 && Math.hypot(x - last.x, y - last.y) < 30;
        this.lastTap = { time: double ? 0 : now, x, y };
        if (double) this.onDoubleTap?.(x, y);
        else this.onTap?.(x, y);
    }

    pan(dx, dy) {
        const h = this.canvas.clientHeight || 1;
        const fov = (this.camera.camera?.fov ?? 60) * DEG;
        const unitsPerPixel = (2 * this.distance * Math.tan(fov / 2)) / h;
        this._right.copy(this.camera.right).mulScalar(-dx * unitsPerPixel);
        this._up.copy(this.camera.up).mulScalar(dy * unitsPerPixel);
        this.targetGoal.add(this._right).add(this._up);
    }

    /** Arrow keys orbit, +/- zoom. Returns true when the key was used. */
    key(code, dt = 1 / 60) {
        const step = 90 * dt * 4;
        if (/^(Arrow|Equal|Minus|Numpad(Add|Subtract))/.test(code)) this.commitView();
        switch (code) {
            case 'ArrowLeft': this.yawGoal -= step; break;
            case 'ArrowRight': this.yawGoal += step; break;
            case 'ArrowUp': this.pitchGoal += step * 0.6; break;
            case 'ArrowDown': this.pitchGoal -= step * 0.6; break;
            case 'Equal': case 'NumpadAdd': this.distanceGoal *= 0.88; break;
            case 'Minus': case 'NumpadSubtract': this.distanceGoal *= 1.12; break;
            default: return false;
        }
        this.idle = 0;
        this.glideTime = 0;
        return true;
    }
}
