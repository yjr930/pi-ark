import type { FastifyInstance } from "fastify";
import type { WorkspaceDefinition } from "./config.js";
import type { MemoryMessageSource, WorkspaceMemory } from "./workspace-memory.js";
import type { WorkspaceService } from "./workspaces.js";

type WorkspaceParams = { workspaceId: string };
type EntryParams = WorkspaceParams & { entryId: string };
type ProposalParams = WorkspaceParams & { proposalId: string };
interface MemoryRoutesOptions {
  memory: WorkspaceMemory;
  workspaces: Pick<WorkspaceService, "get">;
  saveSettings: (workspaceId: string, input: { enabled: boolean; autoIndex: boolean }) => ReturnType<WorkspaceMemory["setSettings"]>;
  sourceStatus: (workspace: WorkspaceDefinition, source: MemoryMessageSource) => Promise<"active" | "historical" | "missing">;
}

export function registerMemoryRoutes(app: FastifyInstance, { memory, workspaces, saveSettings, sourceStatus }: MemoryRoutesOptions): void {
  const path = "/api/workspaces/:workspaceId/memory";
  const store = (id: string) => workspaces.get(id).memoryStoreId;
  app.get<{ Params: WorkspaceParams }>(path, async (request) => memory.snapshot(store(request.params.workspaceId)));
  app.put<{ Params: WorkspaceParams; Body: unknown }>(`${path}/settings`, async (request, reply) => {
    const body = request.body as { enabled?: unknown; autoIndex?: unknown } | null;
    if (typeof body?.enabled !== "boolean" || typeof body.autoIndex !== "boolean") return reply.code(400).send({ error: "Memory settings require enabled and autoIndex flags" });
    return saveSettings(request.params.workspaceId, { enabled: body.enabled, autoIndex: body.autoIndex });
  });
  app.post<{ Params: WorkspaceParams; Body: unknown }>(`${path}/entries`, async (request, reply) => reply.code(201).send(await memory.create(store(request.params.workspaceId), request.body)));
  app.patch<{ Params: EntryParams; Body: unknown }>(`${path}/entries/:entryId`, async (request) => memory.update(store(request.params.workspaceId), request.params.entryId, request.body));
  app.delete<{ Params: EntryParams; Querystring: { revision?: string } }>(`${path}/entries/:entryId`, async (request, reply) => {
    const revision = request.query.revision;
    if (typeof revision !== "string" || !/^\d+$/.test(revision)) return reply.code(400).send({ error: "A Memory revision is required" });
    await memory.remove(store(request.params.workspaceId), request.params.entryId, Number(revision));
    return reply.code(204).send();
  });
  app.post<{ Params: EntryParams }>(`${path}/entries/:entryId/check-source`, async (request, reply) => {
    const workspace = workspaces.get(request.params.workspaceId);
    const { entryId } = request.params;
    const entry = (await memory.snapshot(workspace.memoryStoreId)).entries.find((candidate) => candidate.id === entryId);
    if (!entry) return reply.code(404).send({ error: "Memory entry not found" });
    if (entry.source.kind !== "message" || await sourceStatus(workspace, entry.source) !== "missing") return { entry, sourceAvailable: true };
    return { entry: await memory.markSourceMissing(workspace.memoryStoreId, entry.id, entry.revision), sourceAvailable: false };
  });
  app.get<{ Params: ProposalParams }>(`${path}/proposals/:proposalId`, async (request) => {
    const workspace = workspaces.get(request.params.workspaceId);
    const { proposalId } = request.params;
    const proposal = await memory.getProposal(workspace.memoryStoreId, proposalId);
    const found = await sourceStatus(workspace, proposal.source);
    return { proposal, historical: found === "historical", sourceAvailable: found !== "missing", matches: proposal.status === "pending" ? await memory.matches(workspace.memoryStoreId, proposalId) : [] };
  });
  app.post<{ Params: ProposalParams; Body: { reviewHistorical?: boolean } }>(`${path}/proposals/:proposalId/confirm`, async (request, reply) => {
    const workspace = workspaces.get(request.params.workspaceId);
    const { proposalId } = request.params;
    const proposal = await memory.getProposal(workspace.memoryStoreId, proposalId);
    if (proposal.status === "confirmed") return proposal;
    if (proposal.status === "pending") {
      const found = await sourceStatus(workspace, proposal.source);
      if (found === "missing") return reply.code(409).send({ error: "The Memory proposal's source message is unavailable" });
      if (found === "historical" && request.body?.reviewHistorical !== true) return reply.code(409).send({ error: "Review and confirm the historical branch source first" });
    }
    return memory.confirm(workspace.memoryStoreId, proposalId, request.body);
  });
  app.post<{ Params: ProposalParams }>(`${path}/proposals/:proposalId/dismiss`, async (request) => memory.dismiss(store(request.params.workspaceId), request.params.proposalId));
  app.get<{ Params: WorkspaceParams }>(`${path}/export`, async (request, reply) => {
    const markdown = await memory.exportMarkdown(store(request.params.workspaceId));
    return reply.type("text/markdown; charset=utf-8").header("Content-Disposition", "attachment; filename=\"MEMORY.md\"").send(markdown);
  });
}
