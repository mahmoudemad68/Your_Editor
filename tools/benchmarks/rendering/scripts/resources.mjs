import { readdirSync, readFileSync } from "node:fs";

const TICKS = 100;

function childPids(pid) {
  const found = [];
  let entries;
  try {
    entries = readdirSync("/proc");
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      const parent = Number(stat.slice(close + 2).split(" ")[1]);
      if (parent === pid) {
        const child = Number(entry);
        found.push(child, ...childPids(child));
      }
    } catch {
      // The process exited between the directory listing and the read.
    }
  }
  return found;
}

function processSample(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
    const close = stat.lastIndexOf(")");
    const fields = stat.slice(close + 2).split(" ");
    const rss = Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0);
    return {
      rssKb: rss,
      cpuTicks: Number(fields[11]) + Number(fields[12]),
      browser: /chrome|chromium/i.test(comm),
    };
  } catch {
    return null;
  }
}

export function startSampler(rootPid) {
  let peakRssKb = 0;
  let peakBrowserRssKb = 0;
  const firstTicks = new Map();
  const lastTicks = new Map();
  const take = () => {
    const pids = [rootPid, ...childPids(rootPid)];
    let rss = 0;
    let browser = 0;
    for (const pid of pids) {
      const sample = processSample(pid);
      if (sample === null) {
        continue;
      }
      if (!firstTicks.has(pid)) {
        firstTicks.set(pid, sample.cpuTicks);
      }
      lastTicks.set(pid, sample.cpuTicks);
      rss += sample.rssKb;
      if (sample.browser) {
        browser += sample.rssKb;
      }
    }
    peakRssKb = Math.max(peakRssKb, rss);
    peakBrowserRssKb = Math.max(peakBrowserRssKb, browser);
  };
  take();
  const timer = setInterval(take, 200);
  timer.unref();
  return {
    stop() {
      take();
      clearInterval(timer);
      let ticks = 0;
      for (const [pid, end] of lastTicks) {
        ticks += end - (firstTicks.get(pid) ?? end);
      }
      return {
        peakRssBytes: peakRssKb * 1024,
        browserPeakRssBytes: peakBrowserRssKb * 1024,
        cpuSeconds: Math.max(0, ticks) / TICKS,
      };
    },
  };
}
