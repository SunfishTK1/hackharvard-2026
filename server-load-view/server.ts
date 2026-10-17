import { createServer } from "node:http";
import { existsSync, readFileSync, statSync, statfsSync } from "node:fs";
import { cpus, freemem, hostname, loadavg, totalmem, uptime } from "node:os";
import { extname, join, normalize } from "node:path";

const PORT = Number(process.env.PORT ?? 3000);
const DIST_DIR = join(process.cwd(), "dist");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

interface CpuTicks {
  idle: number;
  total: number;
}

function readCpuTicks(): CpuTicks {
  try {
    if (existsSync("/proc/stat")) {
      const line = readFileSync("/proc/stat", "utf8").split("\n")[0] ?? "";
      const parts = line.trim().split(/\s+/).slice(1).map(Number);
      const idle = (parts[3] ?? 0) + (parts[4] ?? 0);
      const total = parts.reduce((acc, v) => acc + (Number.isFinite(v) ? v : 0), 0);
      if (total > 0) return { idle, total };
    }
  } catch {
    // Fallback to os.cpus()
  }

  let idle = 0;
  let total = 0;
  for (const core of cpus()) {
    idle += core.times.idle;
    total +=
      core.times.user +
      core.times.nice +
      core.times.sys +
      core.times.irq +
      core.times.idle;
  }
  return { idle, total };
}

let prevCpu = readCpuTicks();
let latestCpuPercent = 0;

interface HistoryPoint {
  t: string;
  cpuPercent: number;
  memPercent: number;
  load1: number;
}

const history: HistoryPoint[] = [];

function readMemoryAndSwap() {
  try {
    if (existsSync("/proc/meminfo")) {
      const text = readFileSync("/proc/meminfo", "utf8");
      const kv: Record<string, number> = {};
      for (const line of text.split("\n")) {
        const m = line.match(/^([A-Za-z_()]+):\s+(\d+)/);
        if (m) kv[m[1]] = Number(m[2]); // kB
      }
      const totalKb = kv.MemTotal ?? Math.round(totalmem() / 1024);
      const availKb = kv.MemAvailable ?? kv.MemFree ?? Math.round(freemem() / 1024);
      const cachedKb = (kv.Cached ?? 0) + (kv.Buffers ?? 0) + (kv.SReclaimable ?? 0);
      const usedKb = Math.max(0, totalKb - availKb);

      const swapTotalKb = kv.SwapTotal ?? 0;
      const swapFreeKb = kv.SwapFree ?? 0;
      const swapUsedKb = Math.max(0, swapTotalKb - swapFreeKb);

      const totalMb = Math.round(totalKb / 1024);
      const usedMb = Math.round(usedKb / 1024);
      const availableMb = Math.round(availKb / 1024);
      const cachedMb = Math.round(cachedKb / 1024);
      const usedPercent = totalKb > 0 ? Math.round((usedKb / totalKb) * 100) : 0;

      const swapTotalMb = Math.round(swapTotalKb / 1024);
      const swapUsedMb = Math.round(swapUsedKb / 1024);
      const swapFreeMb = Math.round(swapFreeKb / 1024);
      const swapUsedPercent =
        swapTotalKb > 0 ? Math.round((swapUsedKb / swapTotalKb) * 100) : 0;

      return {
        memory: { totalMb, usedMb, availableMb, cachedMb, usedPercent },
        swap: {
          totalMb: swapTotalMb,
          usedMb: swapUsedMb,
          freeMb: swapFreeMb,
          usedPercent: swapUsedPercent,
        },
      };
    }
  } catch {
    // Fallback below
  }

  const totalMb = Math.round(totalmem() / (1024 * 1024));
  const availableMb = Math.round(freemem() / (1024 * 1024));
  const usedMb = Math.max(0, totalMb - availableMb);
  return {
    memory: {
      totalMb,
      usedMb,
      availableMb,
      cachedMb: 0,
      usedPercent: totalMb > 0 ? Math.round((usedMb / totalMb) * 100) : 0,
    },
    swap: { totalMb: 0, usedMb: 0, freeMb: 0, usedPercent: 0 },
  };
}

function readProcesses() {
  try {
    if (existsSync("/proc/loadavg")) {
      const parts = readFileSync("/proc/loadavg", "utf8").trim().split(/\s+/);
      const [running, total] = (parts[3] ?? "1/1").split("/").map(Number);
      return {
        running: Number.isFinite(running) ? running : 1,
        total: Number.isFinite(total) ? total : 1,
      };
    }
  } catch {
    // Ignore
  }
  return { running: 1, total: 1 };
}

function readDisk() {
  try {
    const st = statfsSync("/");
    const totalBytes = st.blocks * st.bsize;
    const availBytes = st.bavail * st.bsize;
    const usedBytes = Math.max(0, totalBytes - st.bfree * st.bsize);
    const totalGb = totalBytes / 1024 ** 3;
    const usedGb = usedBytes / 1024 ** 3;
    const availableGb = availBytes / 1024 ** 3;
    const usedPercent = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0;
    return { totalGb, usedGb, availableGb, usedPercent };
  } catch {
    return { totalGb: 0, usedGb: 0, availableGb: 0, usedPercent: 0 };
  }
}

function sampleTelemetry() {
  const cur = readCpuTicks();
  const dTotal = cur.total - prevCpu.total;
  const dIdle = cur.idle - prevCpu.idle;
  if (dTotal > 0) {
    latestCpuPercent = Math.max(
      0,
      Math.min(100, Math.round(((dTotal - dIdle) / dTotal) * 100))
    );
  }
  prevCpu = cur;

  const [m1 = 0, m5 = 0, m15 = 0] = loadavg();
  const { memory, swap } = readMemoryAndSwap();
  const now = new Date();
  history.push({
    t: now.toLocaleTimeString("en-US", { hour12: false }),
    cpuPercent: latestCpuPercent,
    memPercent: memory.usedPercent,
    load1: Number(m1.toFixed(2)),
  });
  while (history.length > 30) history.shift();

  const coreList = cpus();
  return {
    timestamp: now.toISOString(),
    hostname: hostname(),
    uptimeSeconds: Math.round(uptime()),
    cpuCount: Math.max(1, coreList.length),
    cpuModel: coreList[0]?.model ?? "Linux vCPU",
    cpuUsagePercent: latestCpuPercent,
    loadAvg: {
      m1: Number(m1.toFixed(2)),
      m5: Number(m5.toFixed(2)),
      m15: Number(m15.toFixed(2)),
    },
    processes: readProcesses(),
    memory,
    swap,
    disk: readDisk(),
    history,
  };
}

// Sample every 2 seconds so history is always warm
sampleTelemetry();
setInterval(sampleTelemetry, 2000).unref();

const server = createServer((req, res) => {
  const urlPath = (req.url ?? "/").split("?")[0] || "/";

  if (urlPath === "/api/load") {
    const payload = sampleTelemetry();
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(payload));
    return;
  }

  if (urlPath === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  const safeSuffix = normalize(urlPath).replace(/^(\.\.(\/|\\|$))+/, "");
  let filePath = join(DIST_DIR, safeSuffix === "/" ? "index.html" : safeSuffix);

  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = join(DIST_DIR, "index.html");
  }

  try {
    const content = readFileSync(filePath);
    const ext = extname(filePath);
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] ?? "application/octet-stream",
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
    });
    res.end(content);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`server-load-view listening on http://0.0.0.0:${PORT}`);
});
