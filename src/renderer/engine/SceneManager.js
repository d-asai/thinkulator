import * as THREE from './three.js';

const BACKGROUND = 0x0c0b0a;
export const FOV = 32;
const BASE_DISTANCE = 8.8;

/**
 * Renderer, camera, lights and environment. Knows nothing about games.
 */
export class SceneManager {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(BACKGROUND);
    // Shelves dissolve into the dark towards the ends instead of popping in.
    this.scene.fog = new THREE.Fog(BACKGROUND, 12.5, 26);

    this.camera = new THREE.PerspectiveCamera(FOV, 16 / 9, 0.1, 80);
    this.cameraDistance = BASE_DISTANCE;

    this._buildEnvironment();
    this._buildLights();

    this.onContextRestored = null;
    this._onLost = (e) => e.preventDefault(); // allow the browser to restore it
    this._onRestored = () => { if (this.onContextRestored) this.onContextRestored(); };
    canvas.addEventListener('webglcontextlost', this._onLost);
    canvas.addEventListener('webglcontextrestored', this._onRestored);

    this.resize();
  }

  /**
   * Image-based lighting from a tiny emissive "photo studio", pre-filtered
   * once with PMREM. This is what gives plastic cases and steelbooks real
   * reflections, at the cost of one small cube map.
   */
  _buildEnvironment() {
    const studio = new THREE.Scene();
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const add = (color, intensity, pos, scale) => {
      const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity), side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(...pos);
      mesh.scale.set(...scale);
      studio.add(mesh);
      return mat;
    };
    const mats = [
      add(0x0b0d12, 1, [0, 0, 0], [40, 30, 40]), //            dark room shell
      add(0xfff1dd, 9, [0, 12, 4], [14, 0.2, 8]), //           warm overhead softbox
      add(0xcfe0ff, 5, [-14, 3, 8], [0.2, 9, 9]), //           cool fill, left
      add(0xffd9b0, 3.5, [14, 2, 6], [0.2, 6, 7]), //          warm kicker, right
      add(0xffffff, 0.7, [0, 5, 18], [16, 3, 0.2]), //         faint strip behind the camera
    ];
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.environment = pmrem.fromScene(studio, 0.03).texture;
    this.scene.environment = this.environment;
    this.scene.environmentIntensity = 0.85;
    pmrem.dispose();
    geo.dispose();
    for (const m of mats) m.dispose();
  }

  /**
   * Lit like a display case: one warm key light from the upper right that
   * casts the shadows, a soft pool on the wall behind the active shelf, and
   * just enough cool fill that the shadow sides of boxes keep their colour.
   */
  _buildLights() {
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x3a3a40, 0.75);
    this.scene.add(this.hemi);

    this.key = new THREE.DirectionalLight(0xfff3e2, 2.4);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    const sc = this.key.shadow.camera;
    sc.left = -10; sc.right = 10; sc.top = 6; sc.bottom = -5; sc.near = 1; sc.far = 34;
    this.key.shadow.bias = -0.0004;
    this.key.shadow.normalBias = 0.025;
    this.key.shadow.radius = 5;
    this.scene.add(this.key, this.key.target);

    this.rim = new THREE.DirectionalLight(0xa9bcff, 0.4);
    this.scene.add(this.rim, this.rim.target);

    // A soft showcase light on the centre of the shelf.
    this.spot = new THREE.SpotLight(0xfff6ea, 1.6, 0, 0.42, 1, 0);
    this.scene.add(this.spot, this.spot.target);
  }

  /** Moves the whole lighting rig with the camera so one shadow map serves any shelf. */
  follow(y) {
    const d = this.cameraDistance;
    this.camera.position.y = y + 1.45;
    this.camera.position.z = d;
    this.camera.lookAt(this.camera.position.x * 0.5, y + 1.0, 0);

    this.key.position.set(5, y + 10, 9);
    this.key.target.position.set(0, y + 0.8, 0);
    this.rim.position.set(-9, y + 4, -3);
    this.rim.target.position.set(0, y + 1, 0);
    this.spot.position.set(0, y + 6, 8);
    this.spot.target.position.set(0, y + 1, 0.5);
  }

  /** Half-width of the view at the shelf plane (z = 0), in world units. */
  get halfWidth() {
    return Math.tan(THREE.MathUtils.degToRad(FOV / 2)) * this.cameraDistance * this.camera.aspect;
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // On narrow windows pull back so at least ~3 boxes stay in frame.
    this.cameraDistance = this.camera.aspect < 1.3 ? BASE_DISTANCE * (1.3 / this.camera.aspect) : BASE_DISTANCE;
    this.scene.fog.near = this.cameraDistance + 1.5;
    this.scene.fog.far = this.cameraDistance + 15;
    this.camera.updateProjectionMatrix();
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.canvas.removeEventListener('webglcontextlost', this._onLost);
    this.canvas.removeEventListener('webglcontextrestored', this._onRestored);
    this.environment.dispose();
    this.key.shadow.dispose();
    this.renderer.dispose();
  }
}
