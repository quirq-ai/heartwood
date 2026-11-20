import {
    AppBase,
    AppOptions,
    Asset,
    CameraComponentSystem,
    CameraFrame,
    Color,
    DEVICETYPE_WEBGL2,
    DEVICETYPE_WEBGPU,
    Entity,
    FILLMODE_FILL_WINDOW,
    GSplatComponentSystem,
    GSplatHandler,
    Picker,
    RESOLUTION_AUTO,
    TONEMAP_LINEAR,
    TextureHandler,
    Vec3,
    createGraphicsDevice,
    platform
} from 'playcanvas';

const isMobile = platform.mobile;

/**
 * Creates the graphics device, the app, the camera with its post effects, and a picker.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {{ renderer?: string|null }} options - 'webgl' forces WebGL2, otherwise WebGPU is
 * preferred with a fallback to WebGL2.
 */
export async function createStage(canvas, { renderer } = {}) {
    const deviceTypes = renderer === 'webgl' ? [DEVICETYPE_WEBGL2] : [DEVICETYPE_WEBGPU, DEVICETYPE_WEBGL2];
    const device = await createGraphicsDevice(canvas, {
        deviceTypes,
        antialias: false,
        powerPreference: 'high-performance'
    });

    const options = new AppOptions();
    options.graphicsDevice = device;
    options.componentSystems = [CameraComponentSystem, GSplatComponentSystem];
    options.resourceHandlers = [TextureHandler, GSplatHandler];

    const app = new AppBase(canvas);
    app.init(options);
    app.setCanvasFillMode(FILLMODE_FILL_WINDOW);
    app.setCanvasResolution(RESOLUTION_AUTO);

    // keep the pixel count sane on very dense screens: splats are fill-rate bound
    const applyPixelRatio = () => {
        const dpr = window.devicePixelRatio || 1;
        const cssPixels = window.innerWidth * window.innerHeight;
        const budget = isMobile ? 1.6e6 : 4.2e6;
        device.maxPixelRatio = Math.max(0.75, Math.min(dpr, 2, Math.sqrt(budget / Math.max(1, cssPixels))));
    };
    applyPixelRatio();
    const onResize = () => {
        applyPixelRatio();
        app.resizeCanvas();
    };
    window.addEventListener('resize', onResize);

    // scene-wide gaussian splat settings
    const gs = app.scene.gsplat;
    gs.radialSorting = true;
    gs.lodUpdateAngle = 90;
    gs.lodBehindPenalty = 2;
    gs.minContribution = 1;
    gs.colorUpdateAngle = 4;
    gs.splatBudget = isMobile ? 1.2e6 : 3.2e6;

    const camera = new Entity('camera');
    camera.addComponent('camera', {
        clearColor: new Color(0.012, 0.014, 0.02),
        fov: 58,
        nearClip: 0.05,
        farClip: 4000,
        toneMapping: TONEMAP_LINEAR
    });
    app.root.addChild(camera);

    // HDR frame: bloom picks up the light the pulse adds, a vignette frames the tree
    const frame = new CameraFrame(app, camera.camera);
    frame.rendering.toneMapping = TONEMAP_LINEAR;
    frame.rendering.samples = 1;
    frame.bloom.intensity = 0.035;
    frame.bloom.threshold = 0.95;
    frame.bloom.blurLevel = 7;
    frame.vignette.intensity = 0.42;
    frame.vignette.inner = 0.42;
    frame.vignette.outer = 1.15;
    frame.vignette.curvature = 0.55;
    frame.update();

    // portrait screens get a wider lens so the canopy still fits
    const fitLens = () => {
        const aspect = window.innerWidth / Math.max(1, window.innerHeight);
        camera.camera.fov = aspect < 0.8 ? 82 : aspect < 1.2 ? 76 : 70;
    };
    fitLens();
    window.addEventListener('resize', fitLens);

    const picker = new Picker(app, 1, 1, true);

    /**
     * World position of the splat under a canvas point (CSS pixels), or null.
     *
     * @param {number} x
     * @param {number} y
     * @returns {Promise<Vec3|null>}
     */
    const pick = async (x, y) => {
        const scale = 0.25;
        const w = Math.max(1, Math.floor(canvas.clientWidth * scale));
        const h = Math.max(1, Math.floor(canvas.clientHeight * scale));
        picker.resize(w, h);
        const worldLayer = app.scene.layers.getLayerByName('World');
        picker.prepare(camera.camera, app.scene, [worldLayer]);
        const point = await picker.getWorldPointAsync(Math.floor(x * scale), Math.floor(y * scale));
        if (!point || !Number.isFinite(point.x)) return null;
        // ignore hits on the far background (sky splats)
        if (point.distance(camera.getPosition()) > 120) return null;
        return point.clone();
    };

    /** Where the view ray through a canvas point meets the horizontal plane at height y. */
    const rayToPlane = (x, y, planeY) => {
        const near = camera.camera.screenToWorld(x, y, camera.camera.nearClip, new Vec3());
        const far = camera.camera.screenToWorld(x, y, camera.camera.farClip, new Vec3());
        const dir = far.sub(near).normalize();
        if (Math.abs(dir.y) < 1e-4) return null;
        const t = (planeY - near.y) / dir.y;
        if (t <= 0 || t > 200) return null;
        return near.add(dir.mulScalar(t));
    };

    app.start();

    return {
        app,
        device,
        camera,
        frame,
        pick,
        rayToPlane,
        isMobile,
        get rendererName() {
            return device.isWebGPU ? 'WebGPU' : 'WebGL2';
        }
    };
}

/**
 * Streams a splat. The coarsest level of detail loads first for a fast start, then the full
 * range streams in.
 *
 * @param {AppBase} app
 * @param {string} url
 * @param {{ onProgress?: (p:number)=>void, onFirstFrame?: ()=>void, onSettled?: ()=>void, onError?: (e:any)=>void }} hooks
 */
export function loadSplat(app, url, hooks = {}) {
    const asset = new Asset('heartwood', 'gsplat', { url });
    const entity = new Entity('splat');
    // SuperSplat's formats (other than .spz) are stored -Y up
    if (!/\.spz(\?|$)/i.test(url)) entity.setLocalEulerAngles(0, 0, 180);

    let maxLoading = 0;
    let phase = 'coarse';
    const system = app.systems.gsplat;

    const onFrameReady = (camera, layer, ready, loadingCount) => {
        maxLoading = Math.max(maxLoading, loadingCount);
        if (phase === 'coarse') {
            hooks.onProgress?.(maxLoading > 0 ? 1 - loadingCount / maxLoading : 0);
            if (ready && loadingCount === 0) {
                phase = 'full';
                maxLoading = 0;
                const gsplat = entity.gsplat;
                if (gsplat) {
                    gsplat.lodRangeMin = 0;
                    gsplat.lodRangeMax = 1000;
                }
                hooks.onFirstFrame?.();
            }
        } else if (phase === 'full') {
            hooks.onStreaming?.(loadingCount);
            if (ready && loadingCount === 0) {
                phase = 'done';
                hooks.onSettled?.();
            }
        } else {
            hooks.onStreaming?.(loadingCount);
        }
    };

    asset.on('load', () => {
        entity.addComponent('gsplat', { asset });
        app.root.addChild(entity);
        const lodLevels = entity.gsplat?.resource?.octree?.lodLevels;
        if (lodLevels) {
            entity.gsplat.lodRangeMin = lodLevels - 1;
            entity.gsplat.lodRangeMax = lodLevels - 1;
            entity.gsplat.lodBaseDistance = 6;
            entity.gsplat.lodMultiplier = 3;
            system.on('frame:ready', onFrameReady);
        } else {
            // a single file: it is all here already
            hooks.onProgress?.(1);
            hooks.onFirstFrame?.();
            hooks.onSettled?.();
        }
    });
    asset.on('error', (err) => hooks.onError?.(err));

    app.assets.add(asset);
    app.assets.load(asset);
    return entity;
}
