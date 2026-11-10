/** Frame-rate independent exponential approach (a LERP whose factor accounts for dt). */
export function damp(current, target, lambda, dt) {
  return target + (current - target) * Math.exp(-lambda * dt);
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smootherstep = (t) => t * t * t * (t * (t * 6 - 15) + 10);

/**
 * A critically damped spring towards `target` (Game Programming Gems 4,
 * "Critically Damped Ease-In/Ease-Out Smoothing").
 *
 * Unlike a plain lerp it carries velocity, so retargeting mid-flight never
 * snaps: a held D-pad glides at constant speed, and releasing it decelerates
 * into the detent with no overshoot. `smoothTime` is roughly the time to
 * cover most of the distance.
 */
export class SmoothValue {
  constructor(value = 0, smoothTime = 0.12) {
    this.value = value;
    this.target = value;
    this.velocity = 0;
    this.smoothTime = smoothTime;
  }

  get settled() {
    return this.value === this.target && this.velocity === 0;
  }

  snap(value) {
    this.value = value;
    this.target = value;
    this.velocity = 0;
  }

  update(dt) {
    if (this.settled) return false;
    const omega = 2 / this.smoothTime;
    const x = omega * dt;
    const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
    const change = this.value - this.target;
    const temp = (this.velocity + omega * change) * dt;
    this.velocity = (this.velocity - omega * temp) * decay;
    this.value = this.target + (change + temp) * decay;

    if (Math.abs(this.value - this.target) < 1e-4 && Math.abs(this.velocity) < 1e-3) {
      this.value = this.target;
      this.velocity = 0;
    }
    return true;
  }
}
