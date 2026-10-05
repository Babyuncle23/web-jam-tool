/**
 * The help sheet's content, kept as data so new topics slot in without
 * touching markup: each section is a titled list of { icon, keys, text }
 * rows — an existing chip icon, a short gesture tag, one line of what it
 * does. main.js renders this into #help-body once; the sheet itself lives
 * outside the cloned screens so it survives view resets.
 */
import { chipIcon } from './icons.js';

export const HELP_SECTIONS = [
  {
    title: 'Tap or hold',
    items: [
      { icon: 'erase', keys: 'tap · hold', text: 'Tap clears your loop — a held press clears every loop.' },
      { icon: 'bars', keys: 'tap · hold', text: 'Tap resizes the loop. Holding while it grows copies the bars in play into the new ones — notes and drums alike.' },
      { icon: 'prev', keys: 'hold', text: 'The back arrow leaves the session on a hold — or on two quick taps.' },
      { icon: 'undo', keys: 'hold', text: 'Undo and redo light up the notes they would touch while held.' },
      { icon: 'sampler', keys: 'hold', text: 'A pad’s SOLO mutes the mix while held; gate pads play for as long as you press.' },
      { icon: 'detail', keys: 'hold', text: 'On the FX pad, holding the right edge catches stutter — ¼ to 1/32 picks the rate.' },
    ],
  },
  {
    title: 'Piano roll',
    items: [
      { icon: 'tap', keys: 'tap', text: 'An empty cell writes a note. Tapping a note deletes it.' },
      { icon: 'drag', keys: 'drag', text: 'A strip moves it; its right edge resizes it.' },
      { icon: 'edit', keys: 'select', text: '“select and move”: drag a box over notes to pick them, then drag any one to move them all.' },
      { icon: 'pinch', keys: 'pinch', text: 'Two fingers zoom. One finger on empty space scrolls the tape.' },
      { icon: 'zoom', keys: 'wheel', text: 'Ctrl+scroll zooms at the cursor; Shift+scroll slides sideways.' },
    ],
  },
  {
    title: 'Drum grid',
    items: [
      { icon: 'tap', keys: 'tap', text: 'A cell toggles a hit.' },
      { icon: 'pinch', keys: 'pinch', text: 'Pinch or Ctrl+scroll zooms; a drag scrolls the grid.' },
      { icon: 'bars', keys: 'hold', text: 'Advanced → Loop: holding a longer size stamps the pattern across the added bars.' },
    ],
  },
];

/** Fill #help-body once — the markup never changes between opens. */
export function renderHelp(body) {
  if (!body || body.children.length) return;
  for (const section of HELP_SECTIONS) {
    const block = document.createElement('section');
    block.className = 'help-sec';
    const title = document.createElement('h3');
    title.className = 'help-sec__title';
    title.textContent = section.title;
    const list = document.createElement('ul');
    list.className = 'help-list';
    for (const item of section.items) {
      const row = document.createElement('li');
      row.className = 'help-item';
      row.append(chipIcon(item.icon));
      const keys = document.createElement('span');
      keys.className = 'help-item__keys';
      keys.textContent = item.keys;
      const text = document.createElement('span');
      text.className = 'help-item__text';
      text.textContent = item.text;
      row.append(keys, text);
      list.append(row);
    }
    block.append(title, list);
    body.append(block);
  }
}
