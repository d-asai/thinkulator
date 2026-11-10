/**
 * The printed card that sits in each shelf's edge rail and names it, the way
 * a shop or library shelf is labelled. Drawn to a small canvas, so nothing is
 * shipped as an image.
 */

export const DISPLAY_FONT = '"Bahnschrift", "DIN Alternate", "Roboto Condensed", "Arial Narrow", sans-serif';

export const LABEL_SIZE = { width: 1024, height: 96 };

/**
 * @param shelf { name, accent, games }
 * @param card  { paper, ink } from the shelf's theme
 */
export function drawShelfLabel(canvas, shelf, card) {
  const { width: w, height: h } = LABEL_SIZE;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);

  ctx.fillStyle = card.paper;
  ctx.fillRect(0, 0, w, h);
  // The tab is the one place the system's own colour appears on the shelf.
  ctx.fillStyle = shelf.accent;
  ctx.fillRect(0, 0, 18, h);

  ctx.fillStyle = card.ink;
  ctx.textBaseline = 'middle';
  ctx.font = `600 46px ${DISPLAY_FONT}`;
  if ('fontStretch' in ctx) ctx.fontStretch = 'condensed';
  if ('letterSpacing' in ctx) ctx.letterSpacing = '4px';
  ctx.textAlign = 'left';
  ctx.fillText(shelf.name.toUpperCase(), 46, h / 2 + 3, w - 250);

  ctx.font = `400 32px ${DISPLAY_FONT}`;
  ctx.textAlign = 'right';
  ctx.globalAlpha = 0.62;
  ctx.fillText(String(shelf.games.length), w - 30, h / 2 + 3);
  ctx.globalAlpha = 1;
}
