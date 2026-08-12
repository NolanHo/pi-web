/**
 * Verification: compare scanSessionInfos() against SDK SessionManager.listAll()
 * field-by-field over the real session data, and time cold vs warm scans.
 *
 * Race handling: sessions can be actively written by a running agent. A file
 * whose mtime changes between the two scans is "live" — both scans legitimately
 * saw different content, so it is excluded from the diff (the index self-heals
 * on the next scan by design).
 *
 * Run with: node_modules/.bin/jiti scripts/verify-session-scan.ts
 */
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { scanSessionInfos, getSessionsRoot } from "../lib/session-scan";
import { sessionPathKey } from "../lib/session-path";
import { unlink, stat, readdir } from "node:fs/promises";
import { join } from "node:path";

const INDEX = join(getSessionsRoot(), ".pi-web-index.json");

function iso(d: Date | string): string {
  return d instanceof Date ? d.toISOString() : String(d);
}

/** Snapshot of mtimeMs per session file, used to detect live writes. */
async function mtimeSnapshot(): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const root = getSessionsRoot();
  let dirs;
  try {
    dirs = await readdir(root, { withFileTypes: true });
  } catch {
    return map;
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    for (const name of await readdir(join(root, dir.name))) {
      if (!name.endsWith(".jsonl")) continue;
      try {
        const s = await stat(join(root, dir.name, name));
        map.set(sessionPathKey(join(root, dir.name, name)), s.mtimeMs);
      } catch { /* vanished */ }
    }
  }
  return map;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const FIELDS = ["id", "cwd", "name", "parentSessionPath", "messageCount", "firstMessage"] as const;

async function compare(label: string) {
  const before = await mtimeSnapshot();
  const sdk = await SessionManager.listAll();
  const scan = await scanSessionInfos();
  const after = await mtimeSnapshot();

  const live = new Set<string>();
  for (const [k, m] of before) {
    if (after.get(k) !== m) live.add(k);
  }

  const sdkByPath = new Map(sdk.map((s) => [sessionPathKey(s.path), s]));
  const scanByPath = new Map(scan.map((s) => [sessionPathKey(s.path), s]));

  const onlySdk = [...sdkByPath.keys()].filter((k) => !scanByPath.has(k) && !live.has(k));
  const onlyScan = [...scanByPath.keys()].filter((k) => !sdkByPath.has(k) && !live.has(k));

  let mismatches = 0;
  let mismatchDetail = "";
  for (const [key, a] of sdkByPath) {
    const b = scanByPath.get(key);
    if (!b) continue;
    for (const f of FIELDS) {
      if (JSON.stringify(a[f]) !== JSON.stringify(b[f])) {
        mismatches++;
        if (mismatchDetail.length < 600) mismatchDetail += `  ${f} ${key}: SDK=${JSON.stringify(a[f])} scan=${JSON.stringify(b[f])}\n`;
      }
    }
    if (iso(a.created) !== iso(b.created)) {
      mismatches++;
      if (mismatchDetail.length < 600) mismatchDetail += `  created ${key}: ${iso(a.created)} vs ${iso(b.created)}\n`;
    }
    if (iso(a.modified) !== iso(b.modified)) {
      mismatches++;
      if (mismatchDetail.length < 600) mismatchDetail += `  modified ${key}: ${iso(a.modified)} vs ${iso(b.modified)}\n`;
    }
  }
  if (scan.length !== sdk.length) mismatches++;

  console.log(`[${label}] SDK=${sdk.length} scan=${scan.length} live=${live.size} onlySdk=${onlySdk.length} onlyScan=${onlyScan.length} mismatches=${mismatches}`);
  if (mismatchDetail) console.log(mismatchDetail);
  if (mismatches > 0 || onlySdk.length > 0 || onlyScan.length > 0) return { ok: false, count: 0 };
  console.log(`[${label}] OK`);
  return { ok: true, count: sdk.length };
}async function main() {
  // 1. Cold: delete index, full scan.
  try { await unlink(INDEX); } catch { /* no index */ }
  const t0 = performance.now();
  const coldResult = await compare("COLD (index deleted)");
  const coldOk = coldResult.ok;
  console.log(`cold total: ${(performance.now() - t0).toFixed(0)}ms`);
  if (!coldOk) {
    // Mismatches on non-live files would be real bugs; but let's double-check
    // once more in case a file started being written between the two scans'
    // stat snapshots (the mtime check has a small window).
    console.log("re-running COLD comparison once to rule out stat-window races...");
    const again = await compare("COLD retry");
    if (!again.ok) {
      console.log("DIFF FAILED (persistent mismatches on non-live files)");
      process.exitCode = 1;
      return;
    }
  }

  // 2. Warm: index was written (fire-and-forget) — give it a moment.
  await sleep(1500);
  const t1 = performance.now();
  const warmResult = await compare("WARM (index hit)");
  const sdkCount = warmResult.count;
  console.log(`warm total: ${(performance.now() - t1).toFixed(0)}ms`);
  if (!warmResult.ok) {
    console.log("WARM DIFF FAILED");
    process.exitCode = 1;
    return;
  }

  // 3. Re-scan in a fresh state: index must persist and be reused (no full read).
  const t2 = performance.now();
  const again = await scanSessionInfos();
  const againMs = (performance.now() - t2).toFixed(0);
  console.log(`re-scan (index reuse): ${againMs}ms, ${again.length} sessions`);
  if (again.length !== sdkCount || Number(againMs) > 1000) {
    console.log("RE-SCAN FAILED (index not reused)");
    process.exitCode = 1;
    return;
  }

  const s = await stat(INDEX).catch(() => null);
  console.log(`index file: ${s ? (s.size / 1024).toFixed(0) + "KB" : "MISSING"}`);
  if (!s || s.size < 100 * 1024) {
    console.log("INDEX FILE TOO SMALL — entries not persisted");
    process.exitCode = 1;
    return;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
