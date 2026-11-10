/**
 * The unified box texture is one horizontal strip, laid out like a printed
 * cover sleeve unfolded flat:
 *
 *     +----------+-------+----------+------+
 *     |   back   | spine |  front   | edge |
 *     +----------+-------+----------+------+
 *      <-- w -->  <- d ->  <-- w -->
 *
 * Column widths are proportional to the box's real dimensions, so the texel
 * density is the same on every face. "edge" is a thin swatch of case colour
 * used for the top, bottom and opening side.
 *
 * Positions are fractions of the atlas width, which makes them independent
 * of resolution: the same geometry UVs fit a 512px atlas and a 2048px one.
 * This module is shared by the mesh factory (UVs) and the stitching worker
 * (pixels), which is what keeps the two in agreement.
 */
export function atlasLayout(profile) {
  const edge = profile.h * 0.02;
  const total = 2 * profile.w + profile.d + edge;
  const a = profile.w / total;
  const b = (profile.w + profile.d) / total;
  const c = (2 * profile.w + profile.d) / total;
  return {
    aspect: total / profile.h, // atlas width / height
    back: [0, a],
    spine: [a, b],
    front: [b, c],
    edge: [c, 1],
  };
}

/** Pixel size of the atlas for a given height. */
export function atlasSize(profile, height) {
  return { width: Math.max(8, Math.round(height * atlasLayout(profile).aspect)), height };
}
