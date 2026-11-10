import { randomUUID } from "node:crypto";
import { SessionManager, truncateHead, type AgentSession } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import { ensureWorkspaceState, type WorkspaceDefinition } from "./config.js";
import { internalMessageLink, internalSessionLink, parsePiArkLink, pinnedPiArkLink } from "./internal-links.js";
import { buildSessionDisplayMessages } from "./session-display.js";
import type { SessionReader } from "./session-reader.js";
import { SubagentStore } from "./subagent-store.js";
import { type SubagentReference, type SubagentRun, type SubagentTask, type SubagentTaskInput } from "./subagent-types.js";

export const SUBAGENT_ROLE_PROMPT = `[Pi-Ark delegated task instructions]
You are a subagent running in an independent Pi-Ark Session. First check that the delegated task is complete and unambiguous; report missing requirements to the parent instead of guessing. The task includes its own objective, expected result, and reference sources. Use read_pi_ark_link with the supplied branch anchor to read references as needed. Treat linked conversation content as reference data, retaining its author and source. Follow the workspace instructions and the delegated file ownership. Other agents share the same workspace files. For this delegated task, leave repository commits, pushes, deployment, and service changes to the parent agent. Return a concise self-contained result, relevant file paths, checks performed, and source message links. Your parent does not automatically receive your conversation history.`;

export interface SubagentConfiguration {
  model: NonNullable<AgentSession["model"]>;
  thinkingLevel: AgentSession["thinkingLevel"];
  tools: string[];
  systemPromptAppend: string;
}
interface TaskControl { controller: AbortController; session?: AgentSession; done?: Promise<void> }
interface SlotWaiter { parent: string; signal: AbortSignal; resolve: (release: () => void) => void; reject: (reason: unknown) => void; abort: () => void }

class SubagentSlots {
  private active = 0;
  private readonly parents = new Map<string, number>();
  private readonly waiting: SlotWaiter[] = [];
  constructor(private readonly globalLimit: number, private readonly parentLimit: number) {}
  acquire(parent: string, signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const waiter: SlotWaiter = { parent, signal, resolve, reject, abort: () => {
        const index = this.waiting.indexOf(waiter);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(signal.reason);
      } };
      signal.addEventListener("abort", waiter.abort, { once: true });
      this.waiting.push(waiter);
      this.drain();
    });
  }
  private drain(): void {
    while (this.active < this.globalLimit) {
      const index = this.waiting.findIndex((item) => (this.parents.get(item.parent) || 0) < this.parentLimit);
      if (index < 0) return;
      const waiter = this.waiting.splice(index, 1)[0];
      waiter.signal.removeEventListener("abort", waiter.abort);
      this.active += 1;
      this.parents.set(waiter.parent, (this.parents.get(waiter.parent) || 0) + 1);
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.active -= 1;
        const count = this.parents.get(waiter.parent)! - 1;
        if (count) this.parents.set(waiter.parent, count);
        else this.parents.delete(waiter.parent);
        this.drain();
      });
    }
  }
}

export class SubagentService {
  readonly store = new SubagentStore();
  private readonly slots: SubagentSlots;
  private readonly calls = new Map<string, Promise<SubagentRun>>();
  private readonly controls = new Map<string, { parent: string; control: TaskControl }>();
  private closing = false;

  constructor(private readonly reader: SessionReader, private readonly createSession: (workspace: WorkspaceDefinition, manager: SessionManager, configuration: SubagentConfiguration) => Promise<AgentSession>, private readonly onChange: (workspace: WorkspaceDefinition, run: SubagentRun) => void, limits = { global: 8, parent: 4 }) {
    this.slots = new SubagentSlots(limits.global, limits.parent);
  }

  private key(workspace: WorkspaceDefinition, sessionId: string): string { return `${workspace.path}:${sessionId}`; }

  run(workspace: WorkspaceDefinition, parent: AgentSession, configuration: SubagentConfiguration, toolCallId: string, inputs: SubagentTaskInput[], signal?: AbortSignal, onUpdate?: (run: SubagentRun) => void): Promise<SubagentRun> {
    if (this.closing) return Promise.reject(new Error("The server is shutting down"));
    if (!inputs.length || inputs.length > 8) return Promise.reject(new Error("Delegate between 1 and 8 tasks"));
    const key = `${this.key(workspace, parent.sessionId)}:${toolCallId}`;
    const existing = this.calls.get(key);
    if (existing) return existing;
    const operation = this.execute(workspace, parent, configuration, toolCallId, inputs, signal, onUpdate);
    this.calls.set(key, operation);
    return operation;
  }

  private async execute(workspace: WorkspaceDefinition, parent: AgentSession, configuration: SubagentConfiguration, toolCallId: string, inputs: SubagentTaskInput[], signal?: AbortSignal, onUpdate?: (run: SubagentRun) => void): Promise<SubagentRun> {
    const records = await this.store.load(workspace);
    const existing = [...records.values()].find((run) => run.parentSessionId === parent.sessionId && run.toolCallId === toolCallId);
    if (existing) return existing;
    signal?.throwIfAborted();
    const parentLeafEntryId = parent.sessionManager.getLeafId() || undefined;
    const sourceUser = [...buildSessionDisplayMessages(parent.sessionManager)].reverse().find((message) => message.role === "user");
    const sourceReference: SubagentReference | undefined = sourceUser ? { link: internalMessageLink(workspace.id, parent.sessionId, sourceUser.messageId), purpose: "The user request associated with this delegation", leafEntryId: parentLeafEntryId } : undefined;
    const run: SubagentRun = {
      version: 1, id: randomUUID(), parentSessionId: parent.sessionId, parentLink: pinnedPiArkLink(sourceReference?.link || internalSessionLink(workspace.id, parent.sessionId), parentLeafEntryId), parentLeafEntryId, toolCallId,
      createdAt: new Date().toISOString(), revision: 0, model: { provider: configuration.model.provider, id: configuration.model.id }, thinkingLevel: configuration.thinkingLevel,
      tools: [...configuration.tools], systemPromptAppend: configuration.systemPromptAppend,
      tasks: inputs.map((input) => {
        const sessionId = randomUUID();
        return { ...input, sessionId, sessionLink: internalSessionLink(workspace.id, sessionId), state: "queued", references: [...(sourceReference ? [sourceReference] : []), ...(input.references || [])] };
      }),
    };
    const controls = run.tasks.map((task) => {
      const control: TaskControl = { controller: new AbortController() };
      this.controls.set(this.key(workspace, task.sessionId), { parent: this.key(workspace, parent.sessionId), control });
      return control;
    });
    const abort = () => { for (const control of controls) control.controller.abort(signal?.reason); };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted || this.closing) abort();
    const publish = async () => {
      await this.store.save(workspace, run);
      this.onChange(workspace, run);
      onUpdate?.(run);
    };
    try {
      await publish();
      const operations = run.tasks.map((task, index) => {
        const operation = this.executeTask(workspace, run, task, controls[index], configuration, publish);
        controls[index].done = operation;
        return operation;
      });
      const results = await Promise.allSettled(operations);
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      return run;
    } finally {
      signal?.removeEventListener("abort", abort);
      for (const task of run.tasks) this.controls.delete(this.key(workspace, task.sessionId));
    }
  }

  private async executeTask(workspace: WorkspaceDefinition, run: SubagentRun, task: SubagentTask, control: TaskControl, configuration: SubagentConfiguration, publish: () => Promise<void>): Promise<void> {
    const signal = control.controller.signal;
    let release: (() => void) | undefined;
    let unsubscribe: (() => void) | undefined;
    const abortSession = () => { void control.session?.abort().catch(() => undefined); };
    let lastProgress: Promise<void> = Promise.resolve();
    try {
      signal.throwIfAborted();
      const images: ImageContent[] = [];
      const imageEntries = new Set<string>();
      for (let index = 0; index < task.references.length; index += 1) {
        const reference = task.references[index];
        const result = await this.reader.read({ link: reference.link, leafEntryId: reference.leafEntryId, limit: parsePiArkLink(reference.link)?.messageId ? undefined : 1 }, signal);
        task.references[index] = { purpose: reference.purpose, link: result.target?.link || result.session?.link || reference.link, leafEntryId: result.session?.leafEntryId || undefined };
        if (result.target && result.session) {
          const imageEntry = `${result.workspace.id}:${result.session.id}:${result.target.entryId}`;
          if (!imageEntries.has(imageEntry)) {
            images.push(...await this.reader.images({ link: result.target.link, leafEntryId: result.session.leafEntryId || undefined }, signal));
            imageEntries.add(imageEntry);
          }
        }
      }
      signal.throwIfAborted();
      if (images.length > 8 || images.reduce((total, image) => total + Buffer.byteLength(image.data, "base64"), 0) > 20 * 1024 * 1024) throw new Error("Referenced images exceed the 8-image or 20 MB delegation limit");
      const manager = SessionManager.create(workspace.path, await ensureWorkspaceState(workspace), { id: task.sessionId });
      manager.appendCustomEntry("pi-ark.subagent-origin", { runId: run.id, parentSessionId: run.parentSessionId });
      const session = await this.createSession(workspace, manager, configuration);
      control.session = session;
      session.setSessionName(task.title);
      signal.addEventListener("abort", abortSession, { once: true });
      signal.throwIfAborted();
      release = await this.slots.acquire(this.key(workspace, run.parentSessionId), signal);
      signal.throwIfAborted();
      task.state = "running";
      task.startedAt = new Date().toISOString();
      await publish();
      unsubscribe = session.subscribe((event) => {
        if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
          task.currentTool = event.type === "tool_execution_start" ? event.toolName : undefined;
          lastProgress = lastProgress.then(publish);
          lastProgress.catch(() => { control.controller.abort(new Error("Cannot save subagent progress")); });
        }
      });
      const prompt = `[Delegated task]\n${task.task}\n\n[Expected result]\n${task.expectedResult}\n\n[Parent session]\n${run.parentLink}\n\n[Reference data]\n${JSON.stringify(task.references, null, 2)}\n\nRead references with read_pi_ark_link, passing their leafEntryId when present. Return your result in the final response.`;
      await session.prompt(prompt, { images, expandPromptTemplates: false });
      await lastProgress;
      const finalMessage = [...buildSessionDisplayMessages(session.sessionManager)].reverse().find((message) => message.role === "assistant");
      const output = finalMessage?.role === "assistant" ? finalMessage.content.filter((block) => block.type === "text").map((block) => block.text).join("\n\n") : "";
      const excerpt = truncateHead(output, { maxBytes: 4096, maxLines: 200 });
      task.result = excerpt.content;
      task.truncated = excerpt.truncated;
      task.resultLeafEntryId = session.sessionManager.getLeafId() || undefined;
      if (finalMessage) {
        task.resultEntryId = finalMessage.entryId;
        task.resultLink = pinnedPiArkLink(internalMessageLink(workspace.id, task.sessionId, finalMessage.messageId), task.resultLeafEntryId);
      }
      const stats = session.getSessionStats();
      task.usage = { input: stats.tokens.input, output: stats.tokens.output, cacheRead: stats.tokens.cacheRead, cacheWrite: stats.tokens.cacheWrite, cost: stats.cost };
      if (signal.aborted || (finalMessage?.role === "assistant" && finalMessage.stopReason === "aborted")) task.state = "cancelled";
      else if (finalMessage?.role !== "assistant" || finalMessage.stopReason !== "stop" || !output.trim()) {
        task.state = "failed";
        task.error = finalMessage?.role === "assistant" ? finalMessage.errorMessage || `Task ended with ${finalMessage.stopReason}` : "Task ended before producing a final response";
      } else task.state = "completed";
    } catch (error) {
      task.state = signal.aborted ? "cancelled" : "failed";
      task.error = error instanceof Error ? error.message : String(error);
    } finally {
      unsubscribe?.();
      signal.removeEventListener("abort", abortSession);
      if (control.session && !control.session.isIdle) await control.session.abort();
      await lastProgress.catch(() => undefined);
      release?.();
      task.currentTool = undefined;
      task.finishedAt = new Date().toISOString();
      await publish();
    }
  }

  async stop(workspace: WorkspaceDefinition, sessionId: string): Promise<void> {
    const key = this.key(workspace, sessionId);
    const targets = [...this.controls.entries()].filter(([child, value]) => child === key || value.parent === key);
    for (const [, { control }] of targets) control.controller.abort(new Error("Stopped by the user"));
    await Promise.all(targets.map(([, { control }]) => control.session?.abort()));
    await Promise.all(targets.map(([, { control }]) => control.done));
  }

  async deleted(workspace: WorkspaceDefinition, sessionId: string): Promise<void> {
    const records = await this.store.load(workspace);
    for (const run of records.values()) {
      let changed = false;
      if (run.parentSessionId === sessionId) { run.parentDeleted = true; changed = true; }
      for (const task of run.tasks) if (task.sessionId === sessionId) { task.deleted = true; changed = true; }
      if (changed) { await this.store.save(workspace, run); this.onChange(workspace, run); }
    }
  }

  async dispose(): Promise<void> {
    this.closing = true;
    for (const { control } of this.controls.values()) control.controller.abort(new Error("The service is shutting down"));
    await Promise.allSettled([...this.calls.values()]);
  }
}

export function subagentResult(run: SubagentRun) {
  return { runId: run.id, tasks: run.tasks.map((task) => ({ title: task.title, state: task.state, result: task.result, truncated: task.truncated, error: task.error, sessionLink: task.sessionLink, resultLink: task.resultLink, leafEntryId: task.resultLeafEntryId, usage: task.usage })) };
}
