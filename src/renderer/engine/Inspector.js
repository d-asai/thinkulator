import * as THREE from './three.js';
import { FOV } from './SceneManager.js';
import { SmoothValue, clamp, damp, lerp, smootherstep } from '../util/motion.js';

const TWO_PI = Math.PI * 2;
const YAW_SPEED = 3.6; //   rad/s at full stick deflection
const PITCH_SPEED = 2.4;
const PITCH_LIMIT = 1.15;
const FILL = 0.5; //        fraction of the view height the box occupies

/**
 * 3D inspection of one box.
 *
 * `t` blends the box between its place on the shelf (0) and a pose floating
 * in front of the camera (1). While inspected, the user owns its orientation:
 * yaw spins the box about its own vertical axis through a full 360 degrees,
 * pitch tips it towards or away from the viewer. Stick input drives angular
 * velocity, which coasts and decays when released, so it handles like a
 * weighted turntable rather than a cursor.
 */
export class Inspector {
  constructor(stage) {
    this.stage = stage;
    this.box = null;
    this.t = new SmoothValue(0, 0.15);
    this.zoom = new SmoothValue(1, 0.12);
    this.launch = new SmoothValue(0, 0.22); // 1 = diving into the box on launch
    this.yaw = 0;
    this.pitch = 0;
    this.yawVelocity = 0;
    this.pitchVelocity = 0;
    this.snapYaw = null;
    this.onClosed = null;
    this._dir = new THREE.Vector3();
  }

  /** True from the moment inspection starts until the user backs out. */
  get active() {
    return this.box !== null && this.t.target === 1;
  }

  /** True while a box is away from its shelf slot, including the return trip. */
  get busy() {
    return this.box !== null;
  }

  enter(box) {
    this.box = box;
    this.t.target = 1;
    this.zoom.snap(1);
    this.yaw = 0;
    this.pitch = 0;
    this.yawVelocity = 0;
    this.pitchVelocity = 0;
    this.snapYaw = null;
  }

  exit() {
    if (!this.box) return;
    this.t.target = 0;
    this.launch.target = 0;
    this.snapYaw = null;
    this.yawVelocity = 0;
    this.pitchVelocity = 0;
    // Unwind by the short way round: at most half a turn back to face front.
    this.yaw = Math.atan2(Math.sin(this.yaw), Math.cos(this.yaw));
  }

  /** Turn to show the back cover (or the front again). */
  flip() {
    this.snapYaw = Math.round(this.yaw / Math.PI) * Math.PI + Math.PI;
  }

  /** Turn the spine (the -X face) towards the viewer. */
  showSpine() {
    this.snapYaw = Math.round((this.yaw - Math.PI / 2) / TWO_PI) * TWO_PI + Math.PI / 2;
  }

  /** Direct manipulation (mouse drag), in radians. */
  drag(dYaw, dPitch, dt) {
    if (!this.active) return;
    this.snapYaw = null;
    this.yaw += dYaw;
    this.pitch = clamp(this.pitch + dPitch, -PITCH_LIMIT, PITCH_LIMIT);
    if (dt > 0) this.yawVelocity = clamp(dYaw / dt, -12, 12); // flick keeps spinning
  }

  /**
   * @param look {x,y} in [-1,1]: rotation stick
   * @param zoomInput [-1,1]: triggers / wheel
   * @returns true while animating
   */
  update(dt, look, zoomInput) {
    if (!this.box) return false;
    let moving = this.t.update(dt);
    moving = this.launch.update(dt) || moving;

    if (this.active) {
      const steering = Math.abs(look.x) > 0.01 || Math.abs(look.y) > 0.01;
      if (steering) this.snapYaw = null;

      if (this.snapYaw !== null) {
        this.yawVelocity = 0;
        this.pitchVelocity = 0;
        this.yaw = damp(this.yaw, this.snapYaw, 10, dt);
        this.pitch = damp(this.pitch, 0, 10, dt);
        if (Math.abs(this.yaw - this.snapYaw) < 0.002) { this.yaw = this.snapYaw; this.snapYaw = null; }
        moving = true;
      } else {
        // Accelerate quickly towards the commanded speed, coast down slowly.
        this.yawVelocity = damp(this.yawVelocity, look.x * YAW_SPEED, steering ? 14 : 4.5, dt);
        this.pitchVelocity = damp(this.pitchVelocity, look.y * PITCH_SPEED, steering ? 14 : 7, dt);
        this.yaw += this.yawVelocity * dt;
        this.pitch = clamp(this.pitch + this.pitchVelocity * dt, -PITCH_LIMIT, PITCH_LIMIT);
        if (Math.abs(this.yawVelocity) > 0.002 || Math.abs(this.pitchVelocity) > 0.002) moving = true;
        else { this.yawVelocity = 0; this.pitchVelocity = 0; }
      }

      if (zoomInput) this.zoom.target = clamp(this.zoom.target - zoomInput * dt * 1.4, 0.55, 1.35);
      moving = this.zoom.update(dt) || moving;
    }

    // Finished the trip home: hand the box back to the shelf.
    if (this.t.target === 0 && this.t.settled) {
      const box = this.box;
      this.box = null;
      this.yaw = 0;
      this.pitch = 0;
      if (this.onClosed) this.onClosed(box);
    }
    return moving;
  }

  /** Called by the shelf with the box's resting pose; writes the blended pose. */
  apply(box, base) {
    const camera = this.stage.camera;
    const e = smootherstep(clamp(this.t.value, 0, 1));
    const size = Math.max(box.profile.h, box.profile.w * 0.85);
    const fit = (size / 2) / (Math.tan(THREE.MathUtils.degToRad(FOV / 2)) * FILL);
    const distance = fit * this.zoom.value * (1 - 0.55 * smootherstep(this.launch.value));

    camera.getWorldDirection(this._dir);
    const tx = camera.position.x + this._dir.x * distance;
    const ty = camera.position.y + this._dir.y * distance + 0.12; // sit slightly above the title text
    const tz = camera.position.z + this._dir.z * distance;

    box.mesh.position.set(lerp(base.x, tx, e), lerp(base.y, ty, e), lerp(base.z, tz, e));
    // XYZ order: yaw about the box's own axis first, then pitch about the screen's X.
    box.mesh.rotation.set(this.pitch * e, base.yaw * (1 - e) + this.yaw * e, 0, 'XYZ');
    box.mesh.scale.setScalar(lerp(base.scale, 1, e));
  }
}
