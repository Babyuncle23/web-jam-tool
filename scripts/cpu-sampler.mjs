/**
 * OS-level cross-check for the CDP numbers: samples per-process CPU for every
 * Chrome process straight from /proc and writes one JSON line per sample.
 * Renderer processes are tagged so a report can attribute CPU to one tab.
 *
 * Usage: node scripts/cpu-sampler.mjs --out /tmp/cpu.jsonl --interval 500
 */

import { readdirSync, readFileSync, createWriteStream } from 'node:fs';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .join(' ')
    .matchAll(/--([\w-]+)[= ]([^\s]+)/g)
    .map((match) => [match[1], match[2]]),
);

const OUT = args.out ?? '/tmp/cpu.jsonl';
const INTERVAL = Number(args.interval ?? 1000);
/** USER_HZ is 100 on Linux, so one jiffy of CPU time is 10 ms. */
const MS_PER_JIFFY = 10;

/**
 * Isolates the thread that runs JS, rAF and paint from the audio and pool
 * threads. The renderer's main thread is the one whose tid equals the pid.
 */
function mainThreadJiffies(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/task/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return Number(fields[11]) + Number(fields[12]);
  } catch {
    return 0;
  }
}

function snapshot() {
  const processes = new Map();
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
      const comm = stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')'));
      if (comm !== 'chrome' && comm !== 'headless_shell') continue;
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const cmdline = readFileSync(`/proc/${entry}/cmdline`, 'utf8');
      const type = cmdline.match(/--type=([\w-]+)/)?.[1] ?? 'browser';
      processes.set(Number(entry), {
        ppid: Number(fields[1]),
        type,
        jiffies: Number(fields[11]) + Number(fields[12]),
        mainThreadJiffies: type === 'renderer' ? mainThreadJiffies(entry) : 0,
      });
    } catch {
      // process vanished between readdir and read
    }
  }
  return processes;
}

const stream = createWriteStream(OUT, { flags: 'w' });
let previous = snapshot();
let previousAt = Date.now();

setInterval(() => {
  const now = Date.now();
  const current = snapshot();
  const seconds = (now - previousAt) / 1000;
  const procs = [];
  for (const [pid, info] of current) {
    const was = previous.get(pid);
    if (!was) continue;
    const toPercent = (delta) => Number((((delta * MS_PER_JIFFY) / 1000 / seconds) * 100).toFixed(1));
    procs.push({
      pid,
      ppid: info.ppid,
      type: info.type,
      cpuPercent: toPercent(info.jiffies - was.jiffies),
      mainThreadPercent: toPercent(info.mainThreadJiffies - was.mainThreadJiffies),
    });
  }
  stream.write(`${JSON.stringify({ at: now, procs })}\n`);
  previous = current;
  previousAt = now;
}, INTERVAL);
