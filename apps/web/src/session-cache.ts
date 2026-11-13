import type { AgentSnapshot, SessionInfo } from "./types";
import { fileLinkKey, type PersistedFileLink } from "./file-links";

export const SESSION_CACHE_LIMIT = 50;
export const SESSION_LIST_CACHE_LIMIT = 100;
export const FILE_LINK_CACHE_LIMIT = 2048;

export interface CachedSessionAttachment { id: string; file: File; preview?: string }
export interface SessionUiState { draft: string; attachments: CachedSessionAttachment[]; disclosures: Record<string, boolean> }
export interface SessionCacheSummary { bytes: number; entries: number; persistent: boolean }

interface PersistedSnapshot { key: string; usedAt: number; snapshot: AgentSnapshot }
interface PersistedAttachment { id: string; file: Blob; previewable: boolean }
interface PersistedUiState { key: string; usedAt: number; draft: string; disclosures: Record<string, boolean>; attachments: PersistedAttachment[] }
interface PersistedSessionList { key: string; usedAt: number; sessions: SessionInfo[] }
export interface PersistedFileLinkRecord extends PersistedFileLink { key: string; usedAt: number }

const SNAPSHOT_STORE = "snapshots";
const UI_STATE_STORE = "uiStates";
const SESSION_LIST_STORE = "sessionLists";
const FILE_LINK_STORE = "fileLinks";
const DATABASE_VERSION = 3;
const DATABASE_PREFIX = "pi-ark-session-cache:";
const PERSISTENCE_DELAY_MS = 250;

const snapshots = new Map<string, AgentSnapshot>();
const snapshotUsedAt = new Map<string, number>();
const uiStates = new Map<string, SessionUiState>();
const uiStateUsedAt = new Map<string, number>();
const sessionLists = new Map<string, SessionInfo[]>();
const sessionListUsedAt = new Map<string, number>();
const pendingSnapshots = new Set<string>();
const pendingUiStates = new Set<string>();
const pendingSessionLists = new Set<string>();
const pendingFileLinks = new Map<string, PersistedFileLinkRecord>();
const snapshotBytes = new Map<string, number>();
const uiStateBytes = new Map<string, number>();
const sessionListBytes = new Map<string, number>();
const fileLinkBytes = new Map<string, number>();

let initializedScope = "";
let initialization: Promise<void> | undefined;
let databaseName = "";
let databasePromise: Promise<IDBDatabase | null> | undefined;
let persistenceAvailable = false;
let usageClock = Date.now();
let persistTimer: ReturnType<typeof setTimeout> | undefined;

function nextUsedAt(): number {
  usageClock = Math.max(usageClock + 1, Date.now());
  return usageClock;
}

function releaseUiState(state: SessionUiState | undefined): void {
  for (const attachment of state?.attachments || []) if (attachment.preview) URL.revokeObjectURL(attachment.preview);
}

function clearMemory(): void {
  for (const state of uiStates.values()) releaseUiState(state);
  snapshots.clear();
  snapshotUsedAt.clear();
  uiStates.clear();
  uiStateUsedAt.clear();
  sessionLists.clear();
  sessionListUsedAt.clear();
  pendingSnapshots.clear();
  pendingUiStates.clear();
  pendingSessionLists.clear();
  pendingFileLinks.clear();
  snapshotBytes.clear();
  uiStateBytes.clear();
  sessionListBytes.clear();
  fileLinkBytes.clear();
}

function byteSize(value: unknown): number {
  try { return new Blob([JSON.stringify(value) ?? ""]).size; }
  catch { return 0; }
}

function cancelScheduledPersistence(): void {
  if (persistTimer !== undefined) clearTimeout(persistTimer);
  persistTimer = undefined;
}

function schedulePersistence(): void {
  if (!persistenceAvailable) return;
  cancelScheduledPersistence();
  persistTimer = setTimeout(() => {
    persistTimer = undefined;
    void flushSessionCache();
  }, PERSISTENCE_DELAY_MS);
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (databasePromise) return databasePromise;
  if (typeof indexedDB === "undefined" || !databaseName) return Promise.resolve(null);
  databasePromise = new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try { request = indexedDB.open(databaseName, DATABASE_VERSION); }
    catch { resolve(null); return; }
    request.onupgradeneeded = () => {
      const database = request.result;
      for (const storeName of [SNAPSHOT_STORE, UI_STATE_STORE, SESSION_LIST_STORE, FILE_LINK_STORE]) {
        const store = database.objectStoreNames.contains(storeName) ? request.transaction!.objectStore(storeName) : database.createObjectStore(storeName, { keyPath: "key" });
        if (!store.indexNames.contains("byUsedAt")) store.createIndex("byUsedAt", "usedAt");
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return databasePromise;
}

async function closeDatabase(): Promise<void> {
  const database = databasePromise ? await databasePromise : null;
  database?.close();
  databasePromise = undefined;
}

function readAll<T>(database: IDBDatabase, storeName: string): Promise<T[]> {
  return new Promise((resolve) => {
    try {
      const request = database.transaction(storeName, "readonly").objectStore(storeName).getAll();
      request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result as T[] : []);
      request.onerror = () => resolve([]);
    } catch { resolve([]); }
  });
}

function writeRecords<T>(database: IDBDatabase, storeName: string, records: T[]): Promise<void> {
  if (records.length === 0) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      const transaction = database.transaction(storeName, "readwrite");
      const store = transaction.objectStore(storeName);
      for (const record of records) {
        try { store.put(record); }
        catch { /* Skip records that cannot be cloned. */ }
      }
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => resolve();
      transaction.onabort = () => resolve();
    } catch { resolve(); }
  });
}

function deleteRecords(database: IDBDatabase, storeName: string, keys: string[]): Promise<void> {
  if (keys.length === 0) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      const transaction = database.transaction(storeName, "readwrite");
      const store = transaction.objectStore(storeName);
      for (const key of keys) store.delete(key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => resolve();
      transaction.onabort = () => resolve();
    } catch { resolve(); }
  });
}

function clearStore(database: IDBDatabase, storeName: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      const transaction = database.transaction(storeName, "readwrite");
      transaction.objectStore(storeName).clear();
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => resolve();
      transaction.onabort = () => resolve();
    } catch { resolve(); }
  });
}

function trimPersistedStore(database: IDBDatabase, storeName: string, limit = SESSION_CACHE_LIMIT): Promise<void> {
  return new Promise((resolve) => {
    try {
      const request = database.transaction(storeName, "readwrite").objectStore(storeName).index("byUsedAt").openCursor(null, "prev");
      let kept = 0;
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) { resolve(); return; }
        if (kept < limit) {
          kept += 1;
          cursor.continue();
        } else {
          cursor.delete();
          cursor.continue();
        }
      };
      request.onerror = () => resolve();
    } catch { resolve(); }
  });
}

function isPersistedSnapshot(value: unknown): value is PersistedSnapshot {
  return Boolean(value && typeof value === "object" && typeof (value as PersistedSnapshot).key === "string" && (value as PersistedSnapshot).snapshot);
}

function isPersistedUiState(value: unknown): value is PersistedUiState {
  return Boolean(value && typeof value === "object" && typeof (value as PersistedUiState).key === "string");
}

function isPersistedSessionList(value: unknown): value is PersistedSessionList {
  return Boolean(value && typeof value === "object" && typeof (value as PersistedSessionList).key === "string" && Array.isArray((value as PersistedSessionList).sessions));
}

function isPersistedFileLinkRecord(value: unknown): value is PersistedFileLinkRecord {
  const record = value as PersistedFileLinkRecord | null;
  return Boolean(record && typeof record === "object" && typeof record.key === "string" && typeof record.workspaceId === "string" && typeof record.basePath === "string" && typeof record.input === "string" && typeof record.path === "string" && (record.type === "file" || record.type === "directory") && Number.isFinite(record.resolvedAt) && Number.isFinite(record.usedAt));
}

function restoreUiState(record: PersistedUiState): SessionUiState {
  const disclosures = record.disclosures && typeof record.disclosures === "object" ? Object.fromEntries(Object.entries(record.disclosures).filter((entry): entry is [string, boolean] => typeof entry[0] === "string" && typeof entry[1] === "boolean")) : {};
  const attachments: CachedSessionAttachment[] = [];
  for (const attachment of Array.isArray(record.attachments) ? record.attachments : []) {
    if (!attachment || typeof attachment.id !== "string") continue;
    const file = attachment.file instanceof File
      ? attachment.file
      : attachment.file instanceof Blob
        ? new File([attachment.file], "attachment", { type: attachment.file.type, lastModified: Date.now() })
        : undefined;
    if (!file) continue;
    const preview = attachment.previewable && typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : undefined;
    attachments.push({ id: attachment.id, file, preview });
  }
  return { draft: typeof record.draft === "string" ? record.draft : "", attachments, disclosures };
}

function persistedUiState(key: string, state: SessionUiState): PersistedUiState {
  return {
    key,
    usedAt: uiStateUsedAt.get(key) || nextUsedAt(),
    draft: state.draft,
    disclosures: state.disclosures,
    attachments: state.attachments.map((attachment) => ({ id: attachment.id, file: attachment.file, previewable: Boolean(attachment.preview) })),
  };
}

async function deletePersistedRecord(storeName: string, key: string): Promise<void> {
  if (!persistenceAvailable) return;
  const database = await openDatabase();
  if (database) await deleteRecords(database, storeName, [key]);
}

export function sessionCacheKey(workspaceId: string, sessionId: string): string {
  return `${workspaceId}:${sessionId}`;
}

function measureSnapshot(key: string): number {
  const snapshot = snapshots.get(key);
  return snapshot ? byteSize({ key, usedAt: snapshotUsedAt.get(key) || 0, snapshot }) : 0;
}

function measureUiState(key: string): number {
  const state = uiStates.get(key);
  if (!state) return 0;
  const metadata = { key, usedAt: uiStateUsedAt.get(key) || 0, draft: state.draft, disclosures: state.disclosures };
  return byteSize(metadata) + state.attachments.reduce((total, attachment) => total + (attachment.file?.size || 0), 0);
}

function measureSessionList(key: string): number {
  const sessions = sessionLists.get(key);
  return sessions ? byteSize({ key, usedAt: sessionListUsedAt.get(key) || 0, sessions }) : 0;
}

export async function initializeSessionCache(scope: string): Promise<void> {
  if (initializedScope === scope) return initialization || Promise.resolve();
  initializedScope = scope;
  databaseName = `${DATABASE_PREFIX}${encodeURIComponent(scope)}`;
  persistenceAvailable = false;
  cancelScheduledPersistence();
  clearMemory();
  initialization = (async () => {
    await closeDatabase();
    if (typeof indexedDB === "undefined") return;
    const database = await openDatabase();
    if (!database) return;
    const [snapshotRecords, uiRecords, listRecords] = await Promise.all([readAll<PersistedSnapshot>(database, SNAPSHOT_STORE), readAll<PersistedUiState>(database, UI_STATE_STORE), readAll<PersistedSessionList>(database, SESSION_LIST_STORE)]);
    const validSnapshots = snapshotRecords.filter(isPersistedSnapshot).sort((left, right) => right.usedAt - left.usedAt).slice(0, SESSION_CACHE_LIMIT);
    const validUiStates = uiRecords.filter(isPersistedUiState).sort((left, right) => right.usedAt - left.usedAt).slice(0, SESSION_CACHE_LIMIT);
    const validLists = listRecords.filter(isPersistedSessionList).sort((left, right) => right.usedAt - left.usedAt).slice(0, SESSION_LIST_CACHE_LIMIT);
    for (const record of validSnapshots) {
      snapshots.set(record.key, record.snapshot);
      snapshotUsedAt.set(record.key, record.usedAt);
      usageClock = Math.max(usageClock, record.usedAt);
    }
    for (const record of validUiStates) {
      uiStates.set(record.key, restoreUiState(record));
      uiStateUsedAt.set(record.key, record.usedAt);
      usageClock = Math.max(usageClock, record.usedAt);
    }
    for (const record of validLists) {
      sessionLists.set(record.key, record.sessions);
      sessionListUsedAt.set(record.key, record.usedAt);
      usageClock = Math.max(usageClock, record.usedAt);
    }
    await Promise.all([trimPersistedStore(database, SNAPSHOT_STORE), trimPersistedStore(database, UI_STATE_STORE), trimPersistedStore(database, SESSION_LIST_STORE, SESSION_LIST_CACHE_LIMIT), trimPersistedStore(database, FILE_LINK_STORE, FILE_LINK_CACHE_LIMIT)]);
    persistenceAvailable = true;
    if (pendingFileLinks.size) schedulePersistence();
  })();
  return initialization;
}

export function getCachedSessionSnapshot(key: string): AgentSnapshot | undefined {
  const snapshot = snapshots.get(key);
  if (!snapshot) return undefined;
  snapshots.delete(key);
  snapshots.set(key, snapshot);
  return snapshot;
}

export function cacheSessionSnapshot(key: string, snapshot: AgentSnapshot): void {
  snapshots.delete(key);
  snapshots.set(key, snapshot);
  snapshotUsedAt.set(key, nextUsedAt());
  snapshotBytes.delete(key);
  pendingSnapshots.add(key);
  while (snapshots.size > SESSION_CACHE_LIMIT) {
    const oldestKey = snapshots.keys().next().value!;
    snapshots.delete(oldestKey);
    snapshotUsedAt.delete(oldestKey);
    snapshotBytes.delete(oldestKey);
    pendingSnapshots.delete(oldestKey);
    void deletePersistedRecord(SNAPSHOT_STORE, oldestKey);
  }
  schedulePersistence();
}

export function getCachedSessionUiState(key: string): SessionUiState | undefined {
  const state = uiStates.get(key);
  if (!state) return undefined;
  uiStates.delete(key);
  uiStates.set(key, state);
  return state;
}

export function cacheSessionUiState(key: string, state: SessionUiState): void {
  uiStates.delete(key);
  uiStates.set(key, state);
  uiStateUsedAt.set(key, nextUsedAt());
  uiStateBytes.delete(key);
  pendingUiStates.add(key);
  while (uiStates.size > SESSION_CACHE_LIMIT) {
    const oldestKey = uiStates.keys().next().value!;
    releaseUiState(uiStates.get(oldestKey));
    uiStates.delete(oldestKey);
    uiStateUsedAt.delete(oldestKey);
    uiStateBytes.delete(oldestKey);
    pendingUiStates.delete(oldestKey);
    void deletePersistedRecord(UI_STATE_STORE, oldestKey);
  }
  schedulePersistence();
}

export function deleteCachedSessionSnapshot(key: string): void {
  snapshots.delete(key);
  snapshotUsedAt.delete(key);
  snapshotBytes.delete(key);
  pendingSnapshots.delete(key);
  releaseUiState(uiStates.get(key));
  uiStates.delete(key);
  uiStateUsedAt.delete(key);
  uiStateBytes.delete(key);
  pendingUiStates.delete(key);
  void deletePersistedRecord(SNAPSHOT_STORE, key);
  void deletePersistedRecord(UI_STATE_STORE, key);
}

export function getCachedSessionList(workspaceId: string): SessionInfo[] | undefined {
  const list = sessionLists.get(workspaceId);
  if (!list) return undefined;
  sessionLists.delete(workspaceId);
  sessionLists.set(workspaceId, list);
  return list;
}

/** Each Workspace keeps its Session list here so switching back never waits for the Server list. */
export function cacheSessionList(workspaceId: string, sessions: SessionInfo[]): void {
  sessionLists.delete(workspaceId);
  sessionLists.set(workspaceId, sessions);
  sessionListUsedAt.set(workspaceId, nextUsedAt());
  sessionListBytes.delete(workspaceId);
  pendingSessionLists.add(workspaceId);
  while (sessionLists.size > SESSION_LIST_CACHE_LIMIT) {
    const oldestKey = sessionLists.keys().next().value!;
    sessionLists.delete(oldestKey);
    sessionListUsedAt.delete(oldestKey);
    sessionListBytes.delete(oldestKey);
    pendingSessionLists.delete(oldestKey);
    void deletePersistedRecord(SESSION_LIST_STORE, oldestKey);
  }
  schedulePersistence();
}

export function cacheResolvedFileLinks(links: PersistedFileLink[]): void {
  for (const link of links) {
    if (!link || !link.input || !link.path || typeof link.workspaceId !== "string" || typeof link.basePath !== "string") continue;
    const key = fileLinkKey(link.workspaceId, link.basePath, link.input);
    const record = { ...link, key, usedAt: nextUsedAt() };
    pendingFileLinks.set(key, record);
    fileLinkBytes.set(key, byteSize(record));
  }
  while (pendingFileLinks.size > FILE_LINK_CACHE_LIMIT) {
    const oldestKey = pendingFileLinks.keys().next().value!;
    pendingFileLinks.delete(oldestKey);
    fileLinkBytes.delete(oldestKey);
  }
  schedulePersistence();
}

/** Confirmed links from earlier page loads are reused before the first transport request. */
export async function readPersistedFileLinks(): Promise<PersistedFileLinkRecord[]> {
  if (!persistenceAvailable) return [];
  const database = await openDatabase();
  if (!database) return [];
  const records = (await readAll<PersistedFileLinkRecord>(database, FILE_LINK_STORE)).filter(isPersistedFileLinkRecord).sort((left, right) => right.usedAt - left.usedAt).slice(0, FILE_LINK_CACHE_LIMIT);
  for (const record of records) fileLinkBytes.set(record.key, byteSize(record));
  await trimPersistedStore(database, FILE_LINK_STORE, FILE_LINK_CACHE_LIMIT);
  return records;
}

export function getSessionCacheSummary(): SessionCacheSummary {
  let bytes = 0;
  for (const key of snapshots.keys()) {
    let size = snapshotBytes.get(key);
    if (size === undefined) { size = measureSnapshot(key); snapshotBytes.set(key, size); }
    bytes += size;
  }
  for (const key of uiStates.keys()) {
    let size = uiStateBytes.get(key);
    if (size === undefined) { size = measureUiState(key); uiStateBytes.set(key, size); }
    bytes += size;
  }
  for (const key of sessionLists.keys()) {
    let size = sessionListBytes.get(key);
    if (size === undefined) { size = measureSessionList(key); sessionListBytes.set(key, size); }
    bytes += size;
  }
  for (const size of fileLinkBytes.values()) bytes += size;
  return { bytes: Math.round(bytes), entries: snapshots.size + uiStates.size + sessionLists.size + fileLinkBytes.size, persistent: persistenceAvailable };
}

export function formatCacheSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${Number(value.toFixed(digits))} ${units[unit]}`;
}

export async function flushSessionCache(): Promise<void> {
  cancelScheduledPersistence();
  if (!persistenceAvailable) return;
  const database = await openDatabase();
  if (!database) return;
  const snapshotRecords: PersistedSnapshot[] = [];
  for (const key of pendingSnapshots) {
    const snapshot = snapshots.get(key);
    if (snapshot) snapshotRecords.push({ key, usedAt: snapshotUsedAt.get(key) || nextUsedAt(), snapshot });
  }
  const uiRecords: PersistedUiState[] = [];
  for (const key of pendingUiStates) {
    const state = uiStates.get(key);
    if (state) uiRecords.push(persistedUiState(key, state));
  }
  const listRecords: PersistedSessionList[] = [];
  for (const key of pendingSessionLists) {
    const sessions = sessionLists.get(key);
    if (sessions) listRecords.push({ key, usedAt: sessionListUsedAt.get(key) || nextUsedAt(), sessions });
  }
  pendingSnapshots.clear();
  pendingUiStates.clear();
  pendingSessionLists.clear();
  const linkRecords = [...pendingFileLinks.values()];
  pendingFileLinks.clear();
  await Promise.all([writeRecords(database, SNAPSHOT_STORE, snapshotRecords), writeRecords(database, UI_STATE_STORE, uiRecords), writeRecords(database, SESSION_LIST_STORE, listRecords), writeRecords(database, FILE_LINK_STORE, linkRecords)]);
  await Promise.all([trimPersistedStore(database, SNAPSHOT_STORE), trimPersistedStore(database, UI_STATE_STORE), trimPersistedStore(database, SESSION_LIST_STORE, SESSION_LIST_CACHE_LIMIT), trimPersistedStore(database, FILE_LINK_STORE, FILE_LINK_CACHE_LIMIT)]);
}

export async function clearSessionCache(): Promise<void> {
  cancelScheduledPersistence();
  clearMemory();
  if (!persistenceAvailable) return;
  const database = await openDatabase();
  if (!database) return;
  await Promise.all([clearStore(database, SNAPSHOT_STORE), clearStore(database, UI_STATE_STORE), clearStore(database, SESSION_LIST_STORE), clearStore(database, FILE_LINK_STORE)]);
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => { void flushSessionCache(); });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") void flushSessionCache(); });
}
