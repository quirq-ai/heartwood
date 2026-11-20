// The scene: "tree_360_8-1" by wanghongtao, published on SuperSplat under CC BY 4.0.
// The splats stream straight from PlayCanvas's CDN (it allows any origin), as a level-of-detail
// set: 4 levels, 5.9M splats at full detail.
export const SCENE = {
    title: 'tree_360_8-1',
    author: 'wanghongtao',
    page: 'https://superspl.at/scene/6a8be890',
    authorPage: 'https://superspl.at/user/wanghongtao',
    license: 'CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    url: 'https://d28zzqy0iyovbz.cloudfront.net/6a8be890/v1/lod-meta.json',
    // a frame of this app (public/og.jpg), blurred behind the intro
    poster: 'og.jpg',

    // where the trunk meets the ground, in world space (the splat is rotated 180° about Z, as
    // SuperSplat does for this format); beat rings start here. Found by picking the trunk base.
    heart: [-15.9, 0.05, 6.45],

    // the orbit the camera starts on: around a point up the trunk, low like the scan was walked,
    // far enough out to watch the rings leave the tree. Round the far side (dip) the low branches
    // are dense, so the drifting camera moves in under them there, to `to` metres from the trunk.
    // The camera stays low when zoomed out (to 24 m): from above, the canopy's outside is
    // barely captured. Leaves and neighbouring trunks near the lens are faded out instead.
    view: { yaw: 30, pitch: -2, distance: 11.5, lift: 2.1, dip: { yaw: 170, inner: 45, outer: 85, to: 6.2 } }
};

// Optional URL overrides, so other SuperSplat scenes can be tried:
//   ?src=<lod-meta.json | .sog | .ply url>&heart=x,y,z
export function readOverrides(params) {
    const out = {};
    const src = params.get('src');
    if (src) out.url = src;
    const heart = params.get('heart');
    if (heart) {
        const v = heart.split(',').map(Number);
        if (v.length === 3 && v.every(Number.isFinite)) out.heart = v;
    }
    return out;
}
