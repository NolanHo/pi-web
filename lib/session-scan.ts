import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";
import { readdir, stat, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SessionInfo as PiSessionInfo } from "@earendil-works/pi-coding-agent";
import { sessionPathKey } from "./session-path";

/**
 * Fast session listing with a disk-persisted incremental index.
 *
 * Replaces SessionManager.listAll() (which reads every .jsonl in full — 500MB+
 * of line-by-line JSON.parse on this machine) with:
 *   1. readdir + stat of all session files (cheap, no file content reads)
 *   2. a disk index keyed by path storing the exact metadata the sidebar needs
 *   3. full lean scans only for files whose mtime/size changed since the index
 *
 * Field semantics are a faithful port of the SDK's buildSessionInfo() (see
 * node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js),
 * minus the allMessagesText field which pi-web never uses.
 */

const INDEX_VERSION = 1;
const INDEX_FILE_NAME = ".pi-web-index.json";
const MAX_CONCURRENT_SCANS = 32;

// ----------------------------------------------------------------------------
// Project resolution cache (cwd → {projectRoot, branch, isWorktree, isTopLevel})
//
// resolveProject() spawns git per unique cwd. In the Next.js server process
// (large RSS) every fork costs tens of ms, so resolving ~90 cwds takes ~1.5s
// after every process restart. Persisting the results to disk makes restarts
// (and dev-server reloads) resolve from disk instead of spawning git.
// ----------------------------------------------------------------------------

const PROJECT_CACHE_FILE_NAME = ".pi-web-project-cache.json";
/** Disk-seeded project entries are considered fresh for this long. */
export const PROJECT_CACHE_TTL_MS = 10 * 60_000;
const PROJECT_CACHE_RELOAD_MS = 10 * 60_000;

interface ProjectCacheEntry {
  projectRoot: string;
  branch: string | null;
  isWorktree: boolean;
  isTopLevel: boolean;
  ts: number;
}

declare global {
  var __piProjectCacheMap: Map<string, ProjectCacheEntry> | undefined;
  var __piProjectCacheLoadedAt: number | undefined;
  var __piProjectCacheDirty: boolean | undefined;
  var __piProjectCacheLoadPromise: Promise<Map<string, ProjectCacheEntry>> | undefined;
}

function projectCachePath(): string {
  return join(getSessionsRoot(), PROJECT_CACHE_FILE_NAME);
}

async function readProjectCacheFromDisk(): Promise<Map<string, ProjectCacheEntry>> {
  try {
    const raw = await readFile(projectCachePath(), "utf8");
    const parsed = JSON.parse(raw) as { version?: number; entries?: Record<string, ProjectCacheEntry> };
    if (parsed.version !== 1 || !parsed.entries) return new Map();
    return new Map(Object.entries(parsed.entries));
  } catch {
    return new Map();
  }
}

/**
 * The project-resolution map, loaded from disk at most once per
 * PROJECT_CACHE_RELOAD_MS. Entries older than PROJECT_CACHE_TTL_MS are ignored
 * by the caller (resolveProject re-resolves them with git). Callers may mutate
 * the returned map; flushProjectCache() persists it.
 *
 * The disk load is promise-memoized: with ~90 concurrent resolveProject calls
 * on a fresh process, a naive read-then-assign would hand each caller its own
 * map instance and their mutations would clobber each other.
 */
export async function getProjectCache(): Promise<Map<string, ProjectCacheEntry>> {
  const loadedAt = globalThis.__piProjectCacheLoadedAt ?? 0;
  const stale = !globalThis.__piProjectCacheMap || Date.now() - loadedAt > PROJECT_CACHE_RELOAD_MS;
  if (stale && !globalThis.__piProjectCacheLoadPromise) {
    globalThis.__piProjectCacheLoadPromise = readProjectCacheFromDisk()
      .then((fromDisk) => {
        globalThis.__piProjectCacheMap = fromDisk;
        globalThis.__piProjectCacheLoadedAt = Date.now();
        return fromDisk;
      })
      .finally(() => {
        globalThis.__piProjectCacheLoadPromise = undefined;
      });
  }
  const map = stale ? await globalThis.__piProjectCacheLoadPromise : globalThis.__piProjectCacheMap;
  return map ?? new Map();
}

/** Persist the map if anything changed since it was loaded. Fire-and-forget. */
export function flushProjectCache(): void {
  if (!globalThis.__piProjectCacheDirty) return;
  globalThis.__piProjectCacheDirty = false;
  const entries = Object.fromEntries(globalThis.__piProjectCacheMap ?? new Map());
  const target = projectCachePath();
  const tmp = `${target}.tmp`;
  void writeFile(tmp, JSON.stringify({ version: 1, entries }))
    .then(() => rename(tmp, target))
    .catch(() => {
      // Best-effort: a failed write only costs a git re-resolution later.
    });
}

/** Mark one cwd as git-resolved so the next flush persists it. */
export function markProjectCacheDirty(): void {
  globalThis.__piProjectCacheDirty = true;
}

/** Called on worktree add/remove — drop both memory and disk state. */
export function invalidateProjectCacheFile(): void {
  globalThis.__piProjectCacheMap = undefined;
  globalThis.__piProjectCacheLoadedAt = undefined;
  globalThis.__piProjectCacheDirty = false;
  void unlink(projectCachePath()).catch(() => {
    // Already gone — nothing to do.
  });
}


export function getSessionsRoot(): string {
  return join(getAgentDir(), "sessions");
}

interface IndexEntry {
  id: string;
  cwd: string;
  name?: string;
  parentSessionPath?: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
  mtimeMs: number;
  size: number;
}

interface IndexFile {
  version: number;
  entries: Record<string, IndexEntry>;
}

interface SessionFile {
  path: string;
  mtimeMs: number;
  size: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---- lean full-file scan (port of SDK buildSessionInfo, no allMessagesText) ----

function isMessageWithContent(message: unknown): message is { role: string; content: unknown } {
  return isRecord(message) && typeof message.role === "string" && "content" in message;
}

function extractTextContent(message: { content: unknown }): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => isRecord(block) && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join(" ");
}

function getMessageActivityTime(entry: { message?: unknown; timestamp?: string }): number | undefined {
  const message = entry.message;
  if (!isMessageWithContent(message)) return undefined;
  if (message.role !== "user" && message.role !== "assistant") return undefined;
  const msgTimestamp = (message as { timestamp?: unknown }).timestamp;
  if (typeof msgTimestamp === "number") return msgTimestamp;
  const t = entry.timestamp ? new Date(entry.timestamp).getTime() : NaN;
  return Number.isNaN(t) ? undefined : t;
}

/** Scan one session file, replicating SDK buildSessionInfo() semantics. */
async function scanSessionFile(filePath: string): Promise<PiSessionInfo | null> {
  try {
    const stats = await stat(filePath);
    let header: Record<string, unknown> | null = null;
    let messageCount = 0;
    let firstMessage = "";
    let name: string | undefined;
    let lastActivityTime: number | undefined;

    const rl = createInterface({
      input: createReadStream(filePath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (!header) {
        if (entry.type !== "session" || typeof entry.id !== "string") return null;
        header = entry;
        continue;
      }
      if (entry.type === "session_info") {
        const candidate = entry.name;
        name = typeof candidate === "string" ? candidate.trim() || undefined : undefined;
      }
      if (entry.type !== "message") continue;
      messageCount++;
      const activityTime = getMessageActivityTime(entry as { message?: unknown; timestamp?: string });
      if (typeof activityTime === "number") {
        lastActivityTime = Math.max(lastActivityTime ?? 0, activityTime);
      }
      const message = (entry as { message?: unknown }).message;
      if (!isMessageWithContent(message)) continue;
      if (message.role !== "user" && message.role !== "assistant") continue;
      const textContent = extractTextContent(message);
      if (!textContent) continue;
      if (!firstMessage && message.role === "user") {
        firstMessage = textContent;
      }
    }
    if (!header) return null;

    const cwd = typeof header.cwd === "string" ? header.cwd : "";
    const parentSessionPath = typeof header.parentSession === "string" ? header.parentSession : undefined;
    const headerTime = typeof header.timestamp === "string" ? new Date(header.timestamp).getTime() : NaN;
    const modified =
      typeof lastActivityTime === "number" && lastActivityTime > 0
        ? new Date(lastActivityTime)
        : !Number.isNaN(headerTime)
          ? new Date(headerTime)
          : stats.mtime;

    return {
      path: filePath,
      id: header.id,
      cwd,
      name,
      parentSessionPath,
      created: typeof header.timestamp === "string" ? new Date(header.timestamp) : stats.mtime,
      modified,
      messageCount,
      firstMessage: firstMessage || "(no messages)",
    } as PiSessionInfo;
  } catch {
    return null;
  }
}

// ---- disk index ----

async function loadIndex(): Promise<Record<string, IndexEntry>> {
  try {
    const raw = await readFile(join(getSessionsRoot(), INDEX_FILE_NAME), "utf8");
    const parsed = JSON.parse(raw) as Partial<IndexFile>;
    if (parsed.version !== INDEX_VERSION || !isRecord(parsed.entries)) return {};
    return parsed.entries as Record<string, IndexEntry>;
  } catch {
    return {};
  }
}

function saveIndex(entries: Record<string, IndexEntry>): void {
  const root = getSessionsRoot();
  const target = join(root, INDEX_FILE_NAME);
  const tmp = `${target}.tmp`;
  void writeFile(tmp, JSON.stringify({ version: INDEX_VERSION, entries }))
    .then(() => rename(tmp, target))
    .catch(() => {
      // Best-effort: a failed write only costs a rescan of changed files next time.
    });
}

function indexEntryToSessionInfo(file: SessionFile, entry: IndexEntry): PiSessionInfo {
  return {
    path: file.path,
    id: entry.id,
    cwd: entry.cwd,
    name: entry.name,
    parentSessionPath: entry.parentSessionPath,
    created: new Date(entry.created),
    modified: new Date(entry.modified),
    messageCount: entry.messageCount,
    firstMessage: entry.firstMessage,
  } as PiSessionInfo;
}

// ---- scan orchestration ----

/** Collect every session file with a pre-scan stat. */
async function collectSessionFiles(): Promise<SessionFile[]> {
  const root = getSessionsRoot();
  const files: SessionFile[] = [];
  let dirs: import("node:fs").Dirent[];
  try {
    dirs = await readdir(root, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    let names: string[];
    try {
      names = await readdir(join(root, dir.name));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(root, dir.name, name);
      try {
        const s = await stat(path);
        files.push({ path, mtimeMs: s.mtimeMs, size: s.size });
      } catch {
        // File vanished mid-scan; skip it.
      }
    }
  }
  return files;
}

/** Scan a batch of files with a bounded concurrency pool. */
async function scanFiles(files: SessionFile[]): Promise<(PiSessionInfo | null)[]> {
  const results = new Array<PiSessionInfo | null>(files.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(MAX_CONCURRENT_SCANS, files.length) }, async () => {
    while (next < files.length) {
      const index = next++;
      results[index] = await scanSessionFile(files[index].path);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * List all sessions with metadata, using the disk index to avoid re-reading
 * unchanged files. Result is sorted by modified descending (same as
 * SessionManager.listAll). Index writes are fire-and-forget.
 */
export async function scanSessionInfos(): Promise<PiSessionInfo[]> {
  const files = await collectSessionFiles();
  const entries = await loadIndex();

  const changed = files.filter(
    (f) => {
      const e = entries[sessionPathKey(f.path)];
      return !e || e.mtimeMs !== f.mtimeMs || e.size !== f.size;
    },
  );
  const scanned = changed.length > 0 ? await scanFiles(changed) : [];
  const changedSet = new Set(changed);
  const scannedByFile = new Map<SessionFile, PiSessionInfo | null>();
  for (let i = 0; i < changed.length; i++) scannedByFile.set(changed[i], scanned[i]);

  const infos: PiSessionInfo[] = [];
  const nextEntries: Record<string, IndexEntry> = {};
  let indexDirty = changed.length > 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const key = sessionPathKey(file.path);
    const scannedInfo = changedSet.has(file) ? (scannedByFile.get(file) ?? null) : null;

    let info: PiSessionInfo | null;
    if (scannedInfo) {
      info = scannedInfo;
      // Store the pre-scan stat: if the file was appended to mid-scan the
      // stored mtime won't match the current one and the next scan re-reads it.
      nextEntries[key] = {
        id: scannedInfo.id,
        cwd: scannedInfo.cwd,
        name: scannedInfo.name,
        parentSessionPath: scannedInfo.parentSessionPath,
        created: scannedInfo.created.toISOString(),
        modified: scannedInfo.modified.toISOString(),
        messageCount: scannedInfo.messageCount,
        firstMessage: scannedInfo.firstMessage,
        mtimeMs: file.mtimeMs,
        size: file.size,
      };
    } else if (scannedInfo === null && changedSet.has(file)) {
      // Corrupt/unreadable file: drop any stale index entry for it.
      indexDirty = true;
      continue;
    } else {
      const cached = entries[key];
      if (!cached) continue;
      info = indexEntryToSessionInfo(file, cached);
      // Carry the unchanged entry forward into the next index generation.
      nextEntries[key] = cached;
    }
    infos.push(info);
  }

  // Drop index entries for deleted sessions. (entries not on disk)
  for (const key of Object.keys(entries)) {
    if (!nextEntries[key]) indexDirty = true;
  }

  if (indexDirty) saveIndex(nextEntries);

  infos.sort((a, b) => b.modified.getTime() - a.modified.getTime());
  return infos;
}
