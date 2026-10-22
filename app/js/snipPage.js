// The screenshot overlay (desktop): the captured screen, full size, where you
// drag around the part with the text. Escape or a click without dragging cancels.
const bridge = window.snip;
const shot = document.getElementById('shot');
const box = document.getElementById('box');
let start = null;
let rect = null;

const place = (r) => {
  box.hidden = false;
  Object.assign(box.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px` });
};

document.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  start = { x: e.clientX, y: e.clientY };
  rect = { ...start, width: 0, height: 0 };
  document.body.classList.add('dragging');
  document.body.setPointerCapture?.(e.pointerId);
});
document.addEventListener('pointermove', (e) => {
  if (!start) return;
  rect = { x: Math.min(start.x, e.clientX), y: Math.min(start.y, e.clientY), width: Math.abs(e.clientX - start.x), height: Math.abs(e.clientY - start.y) };
  place(rect);
});
document.addEventListener('pointerup', () => {
  if (!start) return;
  start = null;
  bridge.done(rect && rect.width >= 4 && rect.height >= 4 ? rect : null);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') bridge.done(null);
});
document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  bridge.done(null);
});

bridge.image().then((src) => {
  if (!src) return bridge.done(null);
  shot.src = src;
});
