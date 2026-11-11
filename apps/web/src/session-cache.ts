import type { AgentSnapshot } from "./types";

export const SESSION_CACHE_LIMIT = 5;

export interface CachedSessionAttachment { id: string; file: File; preview?: string }
export interface SessionUiState { draft: string; attachments: CachedSessionAttachment[]; disclosures: Record<string, boolean> }
export interface SessionCacheSummary { snapshots: number; uiStates: number; persistent: boolean }

interface PersistedSnapshot { key: string; usedAt: number; snapshot: AgentSnapshot }
interface PersistedAttachment { id: string; file: Blob; previewable: boolean }
interface PersistedUiState { key: string; usedAt: number; draft: string; disclosures: Record<string, boolean>; attachments: PersistedAttachment[] }

const SNAPSHOT_STORE = "snapshots";
const UI_STATE_STORE = "uiStates";
const DATABASE_PREFIX = "pi-ark-session-cache:";
const PERSISTENCE_DELAY_MS = 250;

const snapshots = new Map<string, AgentSnapshot>();
const snapshotUsedAt = new Map<string, number>();
const uiStates = new Map<string, SessionUiState>();
const uiStateUsedAt = new Map<string, number>();
const pendingSnapshots = new Set<string>();
const pendingUiStates = new Set<string>();

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
  pendingSnapshots.clear();
  pendingUiStates.clear();
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
    try { request = indexedDB.open(databaseName, 1); }
    catch { resolve(null); return; }
    request.onupgradeneeded = () => {
      const database = request.result;
      for (const storeName of [SNAPSHOT_STORE, UI_STATE_STORE]) {
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

function trimPersistedStore(database: IDBDatabase, storeName: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      const request = database.transaction(storeName, "readwrite").objectStore(storeName).index("byUsedAt").openCursor(null, "prev");
      let kept = 0;
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) { resolve(); return; }
        if (kept < SESSION_CACHE_LIMIT) {
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
    const [snapshotRecords, uiRecords] = await Promise.all([readAll<PersistedSnapshot>(database, SNAPSHOT_STORE), readAll<PersistedUiState>(database, UI_STATE_STORE)]);
    const validSnapshots = snapshotRecords.filter(isPersistedSnapshot).sort((left, right) => right.usedAt - left.usedAt).slice(0, SESSION_CACHE_LIMIT);
    const validUiStates = uiRecords.filter(isPersistedUiState).sort((left, right) => right.usedAt - left.usedAt).slice(0, SESSION_CACHE_LIMIT);
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
    await Promise.all([trimPersistedStore(database, SNAPSHOT_STORE), trimPersistedStore(database, UI_STATE_STORE)]);
    persistenceAvailable = true;
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
  pendingSnapshots.add(key);
  while (snapshots.size > SESSION_CACHE_LIMIT) {
    const oldestKey = snapshots.keys().next().value!;
    snapshots.delete(oldestKey);
    snapshotUsedAt.delete(oldestKey);
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
  pendingUiStates.add(key);
  while (uiStates.size > SESSION_CACHE_LIMIT) {
    const oldestKey = uiStates.keys().next().value!;
    releaseUiState(uiStates.get(oldestKey));
    uiStates.delete(oldestKey);
    uiStateUsedAt.delete(oldestKey);
    pendingUiStates.delete(oldestKey);
    void deletePersistedRecord(UI_STATE_STORE, oldestKey);
  }
  schedulePersistence();
}

export function deleteCachedSessionSnapshot(key: string): void {
  snapshots.delete(key);
  snapshotUsedAt.delete(key);
  pendingSnapshots.delete(key);
  releaseUiState(uiStates.get(key));
  uiStates.delete(key);
  uiStateUsedAt.delete(key);
  pendingUiStates.delete(key);
  void deletePersistedRecord(SNAPSHOT_STORE, key);
  void deletePersistedRecord(UI_STATE_STORE, key);
}

export function getSessionCacheSummary(): SessionCacheSummary {
  return { snapshots: snapshots.size, uiStates: uiStates.size, persistent: persistenceAvailable };
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
  pendingSnapshots.clear();
  pendingUiStates.clear();
  await Promise.all([writeRecords(database, SNAPSHOT_STORE, snapshotRecords), writeRecords(database, UI_STATE_STORE, uiRecords)]);
  await Promise.all([trimPersistedStore(database, SNAPSHOT_STORE), trimPersistedStore(database, UI_STATE_STORE)]);
}

export async function clearSessionCache(): Promise<void> {
  cancelScheduledPersistence();
  clearMemory();
  if (!persistenceAvailable) return;
  const database = await openDatabase();
  if (!database) return;
  await Promise.all([clearStore(database, SNAPSHOT_STORE), clearStore(database, UI_STATE_STORE)]);
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => { void flushSessionCache(); });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") void flushSessionCache(); });
}
