import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureWorkspaceState, type WorkspaceDefinition } from "./config.js";

export interface SessionGroup { id: string; name: string }
export interface SessionMetadata { pinned: boolean; archived: boolean; groups: string[]; updatedAt: string }
interface SessionMetadataStore { version: 2; groups: SessionGroup[]; sessions: Record<string, SessionMetadata> }
const writeQueues = new Map<string, Promise<unknown>>();

function metadataPath(workspace: WorkspaceDefinition): string {
  return join(workspace.path, ".pi-ark", "sessions-meta.json");
}

function normalizeMetadata(value: Partial<SessionMetadata> | undefined): SessionMetadata {
  return { pinned: Boolean(value?.pinned), archived: Boolean(value?.archived), groups: Array.isArray(value?.groups) ? [...new Set(value.groups.filter((id): id is string => typeof id === "string"))] : [], updatedAt: typeof value?.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString() };
}

async function readStore(workspace: WorkspaceDefinition): Promise<SessionMetadataStore> {
  await ensureWorkspaceState(workspace);
  try {
    const parsed = JSON.parse(await readFile(metadataPath(workspace), "utf8")) as { groups?: SessionGroup[]; sessions?: Record<string, Partial<SessionMetadata>> };
    return {
      version: 2,
      groups: Array.isArray(parsed.groups) ? parsed.groups.filter((group) => group && typeof group.id === "string" && typeof group.name === "string") : [],
      sessions: Object.fromEntries(Object.entries(parsed.sessions || {}).map(([id, metadata]) => [id, normalizeMetadata(metadata)])),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 2, groups: [], sessions: {} };
    throw error;
  }
}

async function updateStore<T>(workspace: WorkspaceDefinition, update: (store: SessionMetadataStore) => T | Promise<T>): Promise<T> {
  const key = workspace.path;
  const previous = writeQueues.get(key) || Promise.resolve();
  const operation = previous.catch(() => undefined).then(async () => {
    const store = await readStore(workspace);
    const result = await update(store);
    const target = metadataPath(workspace);
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
    await rename(temporary, target);
    return result;
  });
  writeQueues.set(key, operation);
  try { return await operation; }
  finally { if (writeQueues.get(key) === operation) writeQueues.delete(key); }
}

export async function getSessionMetadata(workspace: WorkspaceDefinition): Promise<Record<string, SessionMetadata>> {
  await writeQueues.get(workspace.path)?.catch(() => undefined);
  return (await readStore(workspace)).sessions;
}

export async function setSessionMetadata(workspace: WorkspaceDefinition, sessionId: string, patch: Partial<Pick<SessionMetadata, "pinned" | "archived" | "groups">>): Promise<SessionMetadata> {
  return updateStore(workspace, (store) => {
    const metadata = { ...normalizeMetadata(store.sessions[sessionId]), ...patch, groups: patch.groups ? [...new Set(patch.groups)] : normalizeMetadata(store.sessions[sessionId]).groups, updatedAt: new Date().toISOString() };
    store.sessions[sessionId] = metadata;
    return metadata;
  });
}

export async function removeSessionMetadata(workspace: WorkspaceDefinition, sessionId: string): Promise<void> {
  await updateStore(workspace, (store) => { delete store.sessions[sessionId]; });
}

export async function listSessionGroups(workspace: WorkspaceDefinition): Promise<SessionGroup[]> {
  await writeQueues.get(workspace.path)?.catch(() => undefined);
  return (await readStore(workspace)).groups;
}

function validateGroupName(store: SessionMetadataStore, inputName: string, exceptId?: string): string {
  const name = inputName?.trim();
  if (!name) throw Object.assign(new Error("Group name is required"), { statusCode: 400 });
  if (store.groups.some((group) => group.id !== exceptId && group.name.toLowerCase() === name.toLowerCase())) throw Object.assign(new Error("A group with this name already exists"), { statusCode: 409 });
  return name;
}

export async function createSessionGroup(workspace: WorkspaceDefinition, inputName: string): Promise<SessionGroup> {
  return updateStore(workspace, (store) => {
    const name = validateGroupName(store, inputName);
    const baseId = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "group";
    let id = baseId;
    let suffix = 2;
    while (store.groups.some((group) => group.id === id)) id = `${baseId}-${suffix++}`;
    const group = { id, name };
    store.groups.push(group);
    return group;
  });
}

export async function renameSessionGroup(workspace: WorkspaceDefinition, groupId: string, inputName: string): Promise<SessionGroup> {
  return updateStore(workspace, (store) => {
    const group = store.groups.find((item) => item.id === groupId);
    if (!group) throw Object.assign(new Error("Unknown session group"), { statusCode: 404 });
    group.name = validateGroupName(store, inputName, groupId);
    return { ...group };
  });
}

export async function deleteSessionGroup(workspace: WorkspaceDefinition, groupId: string): Promise<void> {
  await updateStore(workspace, (store) => {
    if (!store.groups.some((group) => group.id === groupId)) throw Object.assign(new Error("Unknown session group"), { statusCode: 404 });
    store.groups = store.groups.filter((group) => group.id !== groupId);
    for (const metadata of Object.values(store.sessions)) metadata.groups = metadata.groups.filter((id) => id !== groupId);
  });
}
