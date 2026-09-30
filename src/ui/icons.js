/**
 * Filled silhouettes for instruments, effects, drums, and action buttons.
 * The path data is ours; buttons stamp the same node shape.
 */

const PATHS = {
  pad:
    'M3.2 14.4c0-2 3.8-3.6 8.8-3.6s8.8 1.6 8.8 3.6v3c0 2-3.8 3.6-8.8 3.6s-8.8-1.6-8.8-3.6z' +
    'M5.4 8c0-2.2 2.8-4 6.6-4s6.6 1.8 6.6 4v3.2c0 2.2-2.8 4-6.6 4s-6.6-1.8-6.6-4z',
  bass:
    'M10.4 1.4h3.2v2.6h-3.2zM11.2 3.8h1.6v7.2h-1.6z' +
    'M5.4 11.4c1.2-.5 3.6-.8 6.6-.8 4.6 0 7.4 2.2 7.4 5.8 0 3.6-3 6.2-6.8 6.2-4.4 0-7.6-2.8-7.6-6.4 0-1.8.8-3.4 2-4.4-.8-.2-1.6-.3-1.6-.4z' +
    'M12 15.1a2.2 2.2 0 1 1 0 4.4 2.2 2.2 0 1 1 0-4.4z',
  organ: 'M2.2 20.4h19.6v2.2H2.2zM3.2 20.2V9h4.6v11.2zM9.8 20.2V3.2h4.4v17zM16.2 20.2V7.4h4.6v12.8z',
  kalimba: 'M3 12.6h18v8H3zM6.2 12.4V5.2h2.4v7.2zM10.8 12.4V3h2.4v9.4zM15.4 12.4V5.2h2.4v7.2z',
  synth:
    'M2 8.2h3.3v12.4H2zM6.1 8.2h3.3v12.4H6.1zM10.2 8.2h3.3v12.4h-3.3zM14.3 8.2h3.3v12.4h-3.3zM18.4 8.2h3.4v12.4h-3.4z' +
    'M4.5 8.2h2.5v7H4.5zM8.6 8.2h2.5v7H8.6zM12.7 8.2h2.5v7h-2.5zM16.8 8.2h2.5v7h-2.5z',
  sampler:
    'M2.6 2.6h7.9a1 1 0 0 1 1 1v7.9a1 1 0 0 1-1 1H2.6a1 1 0 0 1-1-1V3.6a1 1 0 0 1 1-1z' +
    'M13.5 2.6h7.9a1 1 0 0 1 1 1v7.9a1 1 0 0 1-1 1h-7.9a1 1 0 0 1-1-1V3.6a1 1 0 0 1 1-1z' +
    'M2.6 13.5h7.9a1 1 0 0 1 1 1v7.9a1 1 0 0 1-1 1H2.6a1 1 0 0 1-1-1v-7.9a1 1 0 0 1 1-1z' +
    'M13.5 13.5h7.9a1 1 0 0 1 1 1v7.9a1 1 0 0 1-1 1h-7.9a1 1 0 0 1-1-1v-7.9a1 1 0 0 1 1-1z',
  kick: 'M12 2.1a9.9 9.9 0 1 1 0 19.8 9.9 9.9 0 1 1 0-19.8zM12 5.7a6.3 6.3 0 1 1 0 12.6 6.3 6.3 0 1 1 0-12.6zM12 10.2a1.8 1.8 0 1 1 0 3.6 1.8 1.8 0 1 1 0-3.6z',
  snare:
    'M3.4 7.2C3.4 5.2 7.2 3.8 12 3.8s8.6 1.4 8.6 3.4v7.4c0 2-3.8 3.6-8.6 3.6s-8.6-1.6-8.6-3.6z' +
    'M5.2 18.6l.7 3.2h1.5l.5-2.4.7 2.4h1.4l-.8-3.2z' +
    'M10.2 18.8l.6 3.2h1.5l.4-2.5.7 2.5h1.4l-.7-3.2z' +
    'M15.2 18.6l.7 3.2h1.5l.5-2.4.7 2.4h1.3l-.9-3.2z',
  hat:
    'M2.4 9.6C6 6.2 18 6.2 21.6 9.6 18 11.4 6 11.4 2.4 9.6z' +
    'M3.2 11.4C6.6 9.5 17.4 9.5 20.8 11.4 17.4 13.4 6.6 13.4 3.2 11.4z' +
    'M11.1 12.8h1.8V20.2h-1.8zM8.4 20h7.2v1.7H8.4z',
  clap:
    'M2.2 9.2h2.3v5.6H2.2zM5.1 6.6h2.4v8.2H5.1zM8 7.2h2.3v7.6H8z' +
    'M1.6 13.4h9.2c.8 0 1.4.8 1.2 2-.5 2.6-2.8 4.4-6 4.4H2.4c-1 0-1.8-.8-1.8-1.8v-2.6c0-1.1.6-2 1-2z' +
    'M19.5 9.2h2.3v5.6h-2.3zM16.5 6.6h2.4v8.2h-2.4zM13.7 7.2h2.3v7.6h-2.3z' +
    'M13.2 13.4h9.2c.4 0 1 .9 1 2v2.6c0 1-.8 1.8-1.8 1.8h-3.6c-3.2 0-5.5-1.8-6-4.4-.2-1.2.4-2 1.2-2z',
  openhat:
    'M2.2 6.4C6 3.2 18 3.2 21.8 6.4 18 8.2 6 8.2 2.2 6.4z' +
    'M3.2 12.6C6.8 10.6 17.2 10.6 20.8 12.6 17.2 14.8 6.8 14.8 3.2 12.6z' +
    'M11.1 14.4h1.8V20.2h-1.8zM8.4 20h7.2v1.7H8.4z',
  tom:
    'M4.6 6.4h14.8c0 1.6-3.3 2.8-7.4 2.8S4.6 8 4.6 6.4z' +
    'M4.6 7.2v8.2c0 2 3.3 3.4 7.4 3.4s7.4-1.4 7.4-3.4V7.2z' +
    'M10.8 18.6h2.4v3.2h-2.4zM7.2 21.2h9.6v1.6H7.2z',
  cowbell: 'M9.4 1.6h5.2v3H9.4zM6.2 5h11.6l2.8 15.4H3.4zM8.2 14.6h7.6v2.4H8.2z',
  reverb:
    'M2 9.2h4.2L11.2 4.2v15.6L6.2 14.8H2z' +
    'M13.5 8.7c1.7 1 2.8 2.2 2.8 3.3s-1.1 2.3-2.8 3.3c-.5.3-1.1-.1-1.1-.7 1.1-.8 1.8-1.6 1.8-2.6s-.7-1.8-1.8-2.6c0-.6.6-1 1.1-.7z' +
    'M16.2 5.4c2.9 1.7 4.6 4 4.6 6.6s-1.7 4.9-4.6 6.6c-.5.3-1.1-.1-1.1-.7 2.1-1.4 3.3-3.2 3.3-5.9s-1.2-4.5-3.3-5.9c0-.6.6-1 1.1-.7z',
  delay:
    'M4.6 15.2a2.6 2.6 0 1 1 5.2 0 2.6 2.6 0 1 1-5.2 0zM9.2 14.4V4.8h1.8v9.6z' +
    'M12.4 17.2a2.6 2.6 0 1 1 5.2 0 2.6 2.6 0 1 1-5.2 0zM17 16.4V6.8h1.8v9.6z',
  chorus: 'M2.6 12a4.4 4.4 0 1 1 8.8 0 4.4 4.4 0 1 1-8.8 0zM12.6 12a4.4 4.4 0 1 1 8.8 0 4.4 4.4 0 1 1-8.8 0z',
  drive: 'M13.4 1.4 5.2 13h5.4l-1.8 9.6L19.6 10h-6z',
  cutoff: 'M2.2 17.4h6.4c2.2 0 3.4-1.2 5-4L19.2 5h3v3.4l-6.4 9.4c-1.8 2.6-3.8 4.2-6.8 4.2H2.2z',
  slap: 'M2.2 11.2h19.6v2.8H2.2zM7.4 3.6a3.8 3.8 0 1 1 7.6 0v7.8H7.4z',
  vibrato:
    'M1.4 11.2C3.2 6.4 5.2 6.2 7.2 11.2 9.2 16.2 11.2 16.2 13.2 11.2 15.2 6.2 17.2 6.2 19.2 11.2 20.4 14.2 21.4 15.2 22.8 14.2L22.6 17.4C20.4 19.2 18.6 17.6 17.2 14.4 15.2 9.4 13.2 9.4 11.2 14.4 9.2 19.4 7.2 19.4 5.2 14.4 4 11.6 3 12.6 1.4 14.2Z',
  room: 'M3 4.2h18v15.6H3zM8 8.4h8v7.2H8z',
  reverse: 'M16.6 3.8 4.8 12l11.8 8.2zM17.4 9.4h4.8v5.2h-4.8z',
  loop: 'M12 2.2a9.8 9.8 0 1 1 0 19.6 9.8 9.8 0 1 1 0-19.6zM12 6.6a5.4 5.4 0 1 1 0 10.8 5.4 5.4 0 1 1 0-10.8zM12 9.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 1 1 0-5z',
  erase:
    'M8.2 1.5h7.6v2.2H8.2zM3.6 4.2h16.8v2.4H3.6zM6.4 7.4h11.2l-.9 13.2H7.3zM9.2 10.2h1.8v7H9.2zM13 10.2h1.8v7H13z',
  xmark: 'M5.2 3.6 12 10.4l6.8-6.8 1.8 1.8L13.8 12l6.8 6.8-1.8 1.8L12 13.8l-6.8 6.8-1.8-1.8L10.2 12 3.4 5.4z',
  prev: 'M16 4 6 12l10 8v-3.9L11.4 12 16 7.9z',
  next: 'M8 4l10 8-10 8v-3.9L12.6 12 8 7.9z',
  undo: 'M4 11.2 10.2 5v3.2H15c3.2 0 5.2 2 5.2 4.8V19h-3.4v-5.6c0-1.2-.8-2-1.8-2H10.2v3.2z',
  redo: 'M20 11.2 13.8 5v3.2H9c-3.2 0-5.2 2-5.2 4.8V19h3.4v-5.6c0-1.2.8-2 1.8-2h4.8v3.2z',
  bars: 'M3.2 3h2.8v18H3.2zM10.6 3h2.8v18h-2.8zM18 3h2.8v18H18z',
  done: 'M3.6 12.4 8.8 17.6 20.6 5.4 17.8 2.8 8.8 12.2 6.2 9.6z',
  detail:
    'M4.2 3h2.2v18H4.2zM2.4 7.4h5.8v4.4H2.4z' +
    'M10.9 3h2.2v18h-2.2zM9.1 12.2h5.8v4.4H9.1z' +
    'M17.6 3h2.2v18h-2.2zM15.8 5.2h5.8v4.4h-5.8z',
  notes:
    'M8.6 20.6c-2.7 0-4.6-1.6-4.6-3.6 0-2.1 2-3.5 4.7-3.5 1 0 1.9.2 2.6.7V4.2h2.2V2.4h5.2v2.6h-5.2v8.4c0 2-1.7 3.6-4.7 3.6z',
  play: 'M8 4.4 19.4 12 8 19.6z',
  stop: 'M6.4 6.4h11.2v11.2H6.4z',
  edit:
    'M3 17.25V21h3.75L17.8 9.94l-3.75-3.75L3 17.25z' +
    'M20.7 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75z',
  scissors:
    'M2.4 6.2a3.8 3.8 0 1 0 7.6 0 3.8 3.8 0 0 0-7.6 0z' +
    'M4.4 6.2a1.8 1.8 0 1 1 3.6 0 1.8 1.8 0 0 1-3.6 0z' +
    'M2.4 17.8a3.8 3.8 0 1 0 7.6 0 3.8 3.8 0 0 0-7.6 0z' +
    'M4.4 17.8a1.8 1.8 0 1 1 3.6 0 1.8 1.8 0 0 1-3.6 0z' +
    'M8.9 8.8l13.1 11.3c.7.6.3 1.6-.6 1.5l-11.3-9.6z' +
    'M8.9 15.2L22 3.9c.7-.6.3-1.6-.6-1.5l-11.3 9.6z',
};

const EVENODD = new Set(['kick', 'cowbell', 'bass', 'room', 'loop', 'erase', 'scissors']);
const FILLED = new Set(Object.keys(PATHS));

function svgEl(name) {
  return document.createElementNS('http://www.w3.org/2000/svg', name);
}

/** Oval head, straight stem, one flag: an eighth note, not a scribble. */
function drawEighthNote(svg) {
  const head = svgEl('ellipse');
  head.setAttribute('cx', '8.2');
  head.setAttribute('cy', '17.2');
  head.setAttribute('rx', '4.35');
  head.setAttribute('ry', '3.15');
  head.setAttribute('transform', 'rotate(-28 8.2 17.2)');
  head.setAttribute('fill', 'currentColor');
  const stem = svgEl('rect');
  stem.setAttribute('x', '11.05');
  stem.setAttribute('y', '3.15');
  stem.setAttribute('width', '2.15');
  stem.setAttribute('height', '14.35');
  stem.setAttribute('rx', '0.35');
  stem.setAttribute('fill', 'currentColor');
  const flag = svgEl('path');
  flag.setAttribute('fill', 'currentColor');
  flag.setAttribute('d', 'M13.2 3.2c3.5.35 6.1 2.15 7.3 4.85-2.35-.55-4.55-1.15-7.3-1.45V3.2z');
  svg.append(head, stem, flag);
}

export function chipIcon(id) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('ico');
  if (id === 'notes') {
    drawEighthNote(svg);
    return svg;
  }
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', PATHS[id] || PATHS.synth);
  if (FILLED.has(id) || !PATHS[id]) {
    path.setAttribute('fill', 'currentColor');
    path.setAttribute('fill-rule', EVENODD.has(id) ? 'evenodd' : 'nonzero');
  } else {
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '2.4');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
  }
  svg.append(path);
  return svg;
}

/** Icon plus a label that is allowed to wrap. `detail` is the second line. */
export function paintIconButton(button, iconId, label, detail) {
  button.classList.add('has-icon');
  const text = document.createElement('span');
  text.className = 'chip-label';
  text.append(document.createTextNode(label));
  if (detail) {
    const small = document.createElement('small');
    small.textContent = detail;
    text.append(small);
  }
  button.replaceChildren(chipIcon(iconId), text);
}

/** Replace the words on an icon button without dropping the icon. */
export function setIconLabel(button, label, detail) {
  const text = button?.querySelector('.chip-label');
  if (!text) {
    if (button) button.textContent = label;
    return;
  }
  text.replaceChildren(document.createTextNode(label));
  if (detail) {
    const small = document.createElement('small');
    small.textContent = detail;
    text.append(small);
  }
}
