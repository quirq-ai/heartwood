// The pulse: GPU-side splat modifiers driven by the music.
//
// Everything happens in the engine's `gsplatModifyVS` hook, once per splat, in world space:
//   - rings: expanding bands of light that lift and swell the splats they pass through. Beat
//     rings travel outward around the trunk; tap rings are spheres from the tapped point.
//   - sway: the canopy drifts with the mids and breathes outward with the bass.
//   - sparkle: a few percent of the splats near the tree twinkle with the highs.
//   - dusk: grades the scan toward night so the light carries.
//   - reveal: the scene grows out of the trunk when the experience starts.
//
// The same logic is written twice, GLSL for WebGL2 and WGSL for WebGPU (where it runs inside
// the engine's projection compute shader).

// enough slots that a ring is rarely recycled while it's still visible: beat rings live for
// RING_LIFE seconds, the studio's bass and melody notes for less. When every slot is taken, the
// ring furthest through its life gives way.
export const RING_COUNT = 24;
const RING_LIFE = 8.5;

export const PALETTES = [
    { name: 'Ember', ring: [1.0, 0.5, 0.16], tap: [1.0, 0.3, 0.42], spark: [1.0, 0.82, 0.5], ui: '#ffad66' },
    { name: 'Aurora', ring: [0.22, 1.0, 0.76], tap: [0.6, 0.45, 1.0], spark: [0.72, 1.0, 0.92], ui: '#5cf0c5' },
    { name: 'Blossom', ring: [1.0, 0.38, 0.7], tap: [1.0, 0.7, 0.42], spark: [1.0, 0.86, 0.94], ui: '#ff7fbf' },
    { name: 'Moon', ring: [0.7, 0.82, 1.0], tap: [0.95, 0.96, 1.0], spark: [0.86, 0.92, 1.0], ui: '#c8d6ff' }
];

const glsl = /* glsl */ `
uniform float uTime;
uniform vec3 uHeart;
uniform vec4 uAudio;      // bass, mid, high, level (0..1, smoothed)
uniform vec4 uFx;         // intensity, dusk, reveal radius, beat flash
uniform vec4 uFx2;        // sway, sparkle, ring glow, -
uniform vec3 uTintRing;
uniform vec3 uTintTap;
uniform vec3 uTintSpark;
uniform vec4 uRingA[${RING_COUNT}];   // origin xyz, current radius
uniform vec4 uRingB[${RING_COUNT}];   // current strength, current width, shape (0 ring around trunk, 1 sphere), colour (0 ring, 1 tap, 2 spark)
uniform vec4 uCam;        // camera position, radius around it cleared of everything above the ground

float hwGlow;
vec3 hwTint;
float hwRand;
float hwShow;
float hwFront;
float hwNear;
float hwKeep;

float hwHash(vec3 q) {
    vec3 p = fract(q * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yxz + 33.33);
    return fract((p.x + p.y) * p.z);
}

vec3 hwTintOf(float w) {
    return mix(mix(uTintRing, uTintTap, clamp(w, 0.0, 1.0)), uTintSpark, clamp(w - 1.0, 0.0, 1.0));
}

void modifySplatCenter(inout vec3 center) {
    vec3 p = center;
    vec3 rel = p - uHeart;
    float distH = length(rel.xz);
    hwRand = hwHash(p * 13.37);
    hwNear = 1.0 - smoothstep(14.0, 26.0, distH);

    // the space around the camera is kept clear of everything but the ground, so leaves and
    // trunks between the camera and the tree fade away instead of filling the screen
    float ground = 1.0 - smoothstep(0.3, 0.6, rel.y);
    hwKeep = max(ground, smoothstep(uCam.w * 0.7, uCam.w, length(p - uCam.xyz)));

    // reveal: splats appear as a wave passes them
    float rd = length(vec3(rel.x, rel.y * 0.5, rel.z));
    float rx = (rd - uFx.z) / 1.2;
    hwShow = 1.0 - smoothstep(-1.0, 0.0, rx);
    hwFront = exp(-rx * rx) * step(uFx.z, 500.0);

    hwGlow = 0.0;
    hwTint = vec3(0.0);
    vec3 offset = vec3(0.0);
    for (int i = 0; i < ${RING_COUNT}; i++) {
        vec4 a = uRingA[i];
        vec4 b = uRingB[i];
        if (b.x <= 0.0) continue;
        vec3 d = p - a.xyz;
        float dist = mix(length(vec2(length(d.xz), d.y * 0.3)), length(d), b.z);
        float x = (dist - a.w) / b.y;
        if (abs(x) > 3.5) continue;
        // ground rings are brightest at the ground and wash more softly up through the trees
        float band = exp(-x * x) * b.x * mix(mix(1.0, 0.55, smoothstep(0.5, 7.0, d.y)), 1.0, b.z);
        hwGlow += band;
        hwTint += band * hwTintOf(b.w);
        vec3 dir = d / max(length(d), 0.001);
        offset += (vec3(0.0, 0.1, 0.0) + dir * 0.05) * band;
    }

    // canopy: sway with the mids, breathe out with the bass
    float h = clamp((rel.y - 1.5) / 9.0, 0.0, 1.0) * hwNear;
    float sway = sin(uTime * 0.8 + p.x * 0.31 + p.z * 0.23) + 0.5 * sin(uTime * 1.9 + hwRand * 6.2832);
    float swayAmt = h * (0.02 + uAudio.y * 0.09) * uFx2.x;
    offset.xz += vec2(sway, sway * 0.6) * swayAmt;
    offset.xz += (rel.xz / max(distH, 1.0)) * h * uAudio.x * 0.12 * uFx2.x;

    center = p + offset * uFx.x;
}

void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale) {
    if (hwShow <= 0.001 || hwKeep <= 0.002) {
        scale = vec3(0.0);
        return;
    }
    scale *= mix(0.25, 1.0, hwShow) * (1.0 + min(hwGlow, 2.0) * 0.25 * uFx.x) * mix(0.3, 1.0, hwKeep);
}

void modifySplatColor(vec3 center, inout vec4 color) {
    vec3 c = color.rgb;
    float dusk = uFx.y;
    float lum = dot(c, vec3(0.299, 0.587, 0.114));
    c = mix(c, mix(vec3(lum), c, 0.6) * vec3(0.30, 0.36, 0.52), dusk);
    c *= 1.0 + uFx.w * 0.12 * uFx.x;
    // where many rings overlap their light adds up to no more than about one and a half rings
    vec3 tint = hwTint * (min(hwGlow, 1.4) / max(hwGlow, 0.0001));
    c += tint * (0.4 + dusk * 0.9) * uFx.x * uFx2.z;
    float twinkle = pow(max(0.0, sin(uTime * (2.0 + hwRand * 6.0) + hwRand * 91.0)), 16.0);
    c += uTintSpark * step(0.972, hwRand) * twinkle * hwNear * uFx2.y * (1.0 + dusk);
    c += uTintRing * hwFront * 0.9;
    color.rgb = c;
    color.a *= hwKeep;
}
`;

const wgsl = /* wgsl */ `
uniform uTime: f32;
uniform uHeart: vec3f;
uniform uAudio: vec4f;
uniform uFx: vec4f;
uniform uFx2: vec4f;
uniform uTintRing: vec3f;
uniform uTintTap: vec3f;
uniform uTintSpark: vec3f;
uniform uRingA: array<vec4f, ${RING_COUNT}>;
uniform uRingB: array<vec4f, ${RING_COUNT}>;
uniform uCam: vec4f;

var<private> hwGlow: f32;
var<private> hwTint: vec3f;
var<private> hwRand: f32;
var<private> hwShow: f32;
var<private> hwFront: f32;
var<private> hwNear: f32;
var<private> hwKeep: f32;

fn hwHash(q: vec3f) -> f32 {
    var p = fract(q * vec3f(0.1031, 0.1030, 0.0973));
    p = p + dot(p, p.yxz + 33.33);
    return fract((p.x + p.y) * p.z);
}

fn hwTintOf(w: f32) -> vec3f {
    return mix(mix(uniform.uTintRing, uniform.uTintTap, clamp(w, 0.0, 1.0)), uniform.uTintSpark, clamp(w - 1.0, 0.0, 1.0));
}

fn modifySplatCenter(center: ptr<function, vec3f>) {
    let p = *center;
    let rel = p - uniform.uHeart;
    let distH = length(rel.xz);
    hwRand = hwHash(p * 13.37);
    hwNear = 1.0 - smoothstep(14.0, 26.0, distH);

    let ground = 1.0 - smoothstep(0.3, 0.6, rel.y);
    hwKeep = max(ground, smoothstep(uniform.uCam.w * 0.7, uniform.uCam.w, length(p - uniform.uCam.xyz)));

    let rd = length(vec3f(rel.x, rel.y * 0.5, rel.z));
    let rx = (rd - uniform.uFx.z) / 1.2;
    hwShow = 1.0 - smoothstep(-1.0, 0.0, rx);
    hwFront = exp(-rx * rx) * step(uniform.uFx.z, 500.0);

    hwGlow = 0.0;
    hwTint = vec3f(0.0);
    var offset = vec3f(0.0);
    for (var i = 0; i < ${RING_COUNT}; i++) {
        let a = uniform.uRingA[i];
        let b = uniform.uRingB[i];
        if (b.x <= 0.0) {
            continue;
        }
        let d = p - a.xyz;
        let dist = mix(length(vec2f(length(d.xz), d.y * 0.3)), length(d), b.z);
        let x = (dist - a.w) / b.y;
        if (abs(x) > 3.5) {
            continue;
        }
        let band = exp(-x * x) * b.x * mix(mix(1.0, 0.55, smoothstep(0.5, 7.0, d.y)), 1.0, b.z);
        hwGlow = hwGlow + band;
        hwTint = hwTint + band * hwTintOf(b.w);
        let dir = d / max(length(d), 0.001);
        offset = offset + (vec3f(0.0, 0.1, 0.0) + dir * 0.05) * band;
    }

    let h = clamp((rel.y - 1.5) / 9.0, 0.0, 1.0) * hwNear;
    let sway = sin(uniform.uTime * 0.8 + p.x * 0.31 + p.z * 0.23) + 0.5 * sin(uniform.uTime * 1.9 + hwRand * 6.2832);
    let swayAmt = h * (0.02 + uniform.uAudio.y * 0.09) * uniform.uFx2.x;
    let breathe = (rel.xz / max(distH, 1.0)) * h * uniform.uAudio.x * 0.12 * uniform.uFx2.x;
    offset = offset + vec3f(sway * swayAmt + breathe.x, 0.0, sway * 0.6 * swayAmt + breathe.y);

    *center = p + offset * uniform.uFx.x;
}

fn modifySplatRotationScale(originalCenter: vec3f, modifiedCenter: vec3f, rotation: ptr<function, vec4f>, scale: ptr<function, vec3f>) {
    if (hwShow <= 0.001 || hwKeep <= 0.002) {
        *scale = vec3f(0.0);
        return;
    }
    *scale = *scale * (mix(0.25, 1.0, hwShow) * (1.0 + min(hwGlow, 2.0) * 0.25 * uniform.uFx.x) * mix(0.3, 1.0, hwKeep));
}

fn modifySplatColor(center: vec3f, color: ptr<function, vec4f>) {
    var c = (*color).rgb;
    let dusk = uniform.uFx.y;
    let lum = dot(c, vec3f(0.299, 0.587, 0.114));
    c = mix(c, mix(vec3f(lum), c, 0.6) * vec3f(0.30, 0.36, 0.52), dusk);
    c = c * (1.0 + uniform.uFx.w * 0.12 * uniform.uFx.x);
    let tint = hwTint * (min(hwGlow, 1.4) / max(hwGlow, 0.0001));
    c = c + tint * (0.4 + dusk * 0.9) * uniform.uFx.x * uniform.uFx2.z;
    let twinkle = pow(max(0.0, sin(uniform.uTime * (2.0 + hwRand * 6.0) + hwRand * 91.0)), 16.0);
    c = c + uniform.uTintSpark * (step(0.972, hwRand) * twinkle * hwNear * uniform.uFx2.y * (1.0 + dusk));
    c = c + uniform.uTintRing * (hwFront * 0.9);
    *color = vec4f(c, (*color).a * hwKeep);
}
`;

const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, x) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
};

export class PulseField {
    /**
     * @param {import('playcanvas').ShaderMaterial} material - app.scene.gsplat.material
     */
    constructor(material) {
        this.material = material;
        material.getShaderChunks('glsl').set('gsplatModifyVS', glsl);
        material.getShaderChunks('wgsl').set('gsplatModifyVS', wgsl);
        material.update();

        this.time = 0;
        this.rings = Array.from({ length: RING_COUNT }, () => ({
            live: false, x: 0, y: 0, z: 0, birth: -1e9, amp: 0, speed: 0, width: 1, shape: 0, tint: 0, life: RING_LIFE
        }));
        this.ringA = new Float32Array(RING_COUNT * 4);
        this.ringB = new Float32Array(RING_COUNT * 4);

        this.heart = new Float32Array(3);
        this.audio = new Float32Array(4);
        this.fx = new Float32Array(4);
        this.fx2 = new Float32Array(4);
        // camera position + the radius around it kept clear of anything above the ground
        this.cam = new Float32Array([0, 0, 0, 0.01]);

        this.palette = PALETTES[0];
        this.tintRing = Float32Array.from(this.palette.ring);
        this.tintTap = Float32Array.from(this.palette.tap);
        this.tintSpark = Float32Array.from(this.palette.spark);

        // settings (0..1), smoothed toward their targets every frame
        this.intensity = 0.85;
        this.dusk = 0.45;
        this.targetIntensity = this.intensity;
        this.targetDusk = this.dusk;

        this.reveal = 0;          // radius of the reveal wave; 1e5 once everything is shown
        this.beat = 0;            // flash envelope, set on kicks
        this.sparkle = 0;         // sparkle envelope, set on plucks and chimes
    }

    setPalette(index) {
        this.palette = PALETTES[index] ?? PALETTES[0];
    }

    /**
     * Starts a ring. Shape 0 travels outward around a vertical axis (beat rings), shape 1 is a
     * sphere (tap ripples, melody notes). Tint 0 takes the palette's ring colour, 1 its tap
     * colour, 2 its sparkle colour; life is in seconds.
     */
    ring(origin, { amp = 1, speed = 7, width = 0.9, shape = 0, tint = shape, life = RING_LIFE } = {}) {
        // a free slot, else the one furthest through its life (by then it has all but faded)
        let slot = this.rings.find((r) => !r.live);
        if (!slot) {
            const used = (r) => (this.time - r.birth) / r.life;
            slot = this.rings.reduce((a, r) => (used(r) > used(a) ? r : a));
        }
        slot.live = true;
        slot.x = origin[0] ?? origin.x;
        slot.y = origin[1] ?? origin.y;
        slot.z = origin[2] ?? origin.z;
        slot.birth = this.time;
        slot.amp = amp;
        slot.speed = speed;
        slot.width = width;
        slot.shape = shape;
        slot.tint = tint;
        slot.life = life;
    }

    clearRings() {
        for (const r of this.rings) r.live = false;
    }

    /** The camera's position, and the space around it to keep clear of anything above the ground. */
    setView(position, clearRadius) {
        this.cam[0] = position.x;
        this.cam[1] = position.y;
        this.cam[2] = position.z;
        this.cam[3] = Math.max(0.01, clearRadius);
    }

    /** Writes each ring's radius, strength and width for this moment into the uniform arrays. */
    packRings() {
        for (let i = 0; i < RING_COUNT; i++) {
            const r = this.rings[i];
            const o = i * 4;
            let radius = 0;
            let strength = 0;
            let width = 1;
            if (r.live) {
                const age = this.time - r.birth;
                if (age > r.life) {
                    r.live = false;
                } else {
                    radius = r.speed * age;
                    // eases in, then fades slowly with time and distance, so a ring stays
                    // visible as it leaves the tree and washes over the trees around it
                    strength = r.amp *
                        Math.min(1, age * 10) *
                        Math.exp(-age * 0.25) *
                        (1 - smoothstep(30, 56, radius)) *
                        (1 - smoothstep(r.life > 4 ? r.life - 2 : r.life * 0.35, r.life, age));
                    // and spreads a little as it travels, staying a line rather than a wash
                    width = r.width * (1 + radius * 0.012);
                }
            }
            this.ringA[o] = r.x;
            this.ringA[o + 1] = r.y;
            this.ringA[o + 2] = r.z;
            this.ringA[o + 3] = radius;
            this.ringB[o] = strength > 0.003 ? strength : 0;
            this.ringB[o + 1] = width;
            this.ringB[o + 2] = r.shape;
            this.ringB[o + 3] = r.tint;
        }
    }

    /**
     * @param {number} dt - seconds
     * @param {{bass:number, mid:number, high:number, level:number}} levels - smoothed audio levels
     * @param {number[]} heart - world position of the trunk base
     */
    update(dt, levels, heart) {
        this.time += dt;
        const k = 1 - Math.exp(-dt * 4);
        this.packRings();

        this.intensity = lerp(this.intensity, this.targetIntensity, k);
        this.dusk = lerp(this.dusk, this.targetDusk, k);
        this.beat *= Math.exp(-dt * 5);
        this.sparkle *= Math.exp(-dt * 2.2);

        for (let i = 0; i < 3; i++) {
            this.tintRing[i] = lerp(this.tintRing[i], this.palette.ring[i], k);
            this.tintTap[i] = lerp(this.tintTap[i], this.palette.tap[i], k);
            this.tintSpark[i] = lerp(this.tintSpark[i], this.palette.spark[i], k);
        }

        this.heart.set(heart);
        this.audio[0] = levels.bass;
        this.audio[1] = levels.mid;
        this.audio[2] = levels.high;
        this.audio[3] = levels.level;
        this.fx[0] = this.intensity;
        this.fx[1] = this.dusk;
        this.fx[2] = this.reveal;
        this.fx[3] = this.beat;
        this.fx2[0] = 1;                                                    // sway
        this.fx2[1] = this.intensity * (0.25 + levels.high * 1.6 + this.sparkle * 1.4); // sparkle
        this.fx2[2] = 1;                                                    // ring glow

        const m = this.material;
        m.setParameter('uTime', this.time);
        m.setParameter('uHeart', this.heart);
        m.setParameter('uAudio', this.audio);
        m.setParameter('uFx', this.fx);
        m.setParameter('uFx2', this.fx2);
        m.setParameter('uTintRing', this.tintRing);
        m.setParameter('uTintTap', this.tintTap);
        m.setParameter('uTintSpark', this.tintSpark);
        m.setParameter('uRingA[0]', this.ringA);
        m.setParameter('uRingB[0]', this.ringB);
        m.setParameter('uCam', this.cam);
        m.update();
    }
}
