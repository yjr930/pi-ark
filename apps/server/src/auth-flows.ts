import { randomUUID } from "node:crypto";

export type AuthFlowPromptInput = { signal?: AbortSignal } & ({ type: "text" | "secret" | "manual_code"; message: string; placeholder?: string } | { type: "select"; message: string; options: readonly { id: string; label: string; description?: string }[] });
export type AuthFlowEventInput = { type: "info"; message: string; links?: readonly { url: string; label?: string }[] } | { type: "auth_url"; url: string; instructions?: string } | { type: "device_code"; userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number } | { type: "progress"; message: string };
export interface AuthFlowInteraction { signal: AbortSignal; prompt(prompt: AuthFlowPromptInput): Promise<string>; notify(event: AuthFlowEventInput): void }
export interface AuthFlowView {
  id: string;
  providerId: string;
  status: "pending" | "success" | "error" | "cancelled";
  events: Array<AuthFlowEventInput & { id: number }>;
  prompt?: { id: string; type: AuthFlowPromptInput["type"]; message: string; placeholder?: string; options?: Array<{ id: string; label: string; description?: string }> };
  error?: string;
}
interface Flow extends AuthFlowView { controller: AbortController; answer?: { promptId: string; resolve: (value: string) => void; reject: (error: Error) => void } }

export class AuthFlowService {
  private readonly flows = new Map<string, Flow>();
  constructor(private readonly runner: (providerId: string, interaction: AuthFlowInteraction) => Promise<void>) {}

  start(providerId: string): AuthFlowView {
    const id = randomUUID();
    const controller = new AbortController();
    const flow: Flow = { id, providerId, status: "pending", events: [], controller };
    this.flows.set(id, flow);
    const interaction: AuthFlowInteraction = {
      signal: controller.signal,
      notify: (event) => {
        if (flow.status !== "pending") return;
        flow.events.push({ ...event, id: flow.events.length + 1 });
        if (flow.events.length > 50) flow.events.splice(0, flow.events.length - 50);
      },
      prompt: (prompt) => {
        if (flow.status !== "pending" || controller.signal.aborted) return Promise.reject(new Error("Login cancelled"));
        if (flow.answer) flow.answer.reject(new Error("Login prompt replaced"));
        const promptId = randomUUID();
        flow.prompt = { id: promptId, type: prompt.type, message: prompt.message, placeholder: "placeholder" in prompt ? prompt.placeholder : undefined, options: prompt.type === "select" ? [...prompt.options] : undefined };
        return new Promise<string>((resolve, reject) => {
          flow.answer = { promptId, resolve: (value) => { flow.prompt = undefined; flow.answer = undefined; resolve(value); }, reject: (error) => { flow.prompt = undefined; flow.answer = undefined; reject(error); } };
          prompt.signal?.addEventListener("abort", () => { if (flow.answer?.promptId === promptId) flow.answer.reject(new Error("Login prompt completed elsewhere")); }, { once: true });
        });
      },
    };
    void this.runner(providerId, interaction).then(() => { if (flow.status === "pending") { flow.status = "success"; flow.prompt = undefined; flow.answer = undefined; } }).catch((error) => { if (flow.status === "pending") { flow.status = controller.signal.aborted ? "cancelled" : "error"; flow.error = error instanceof Error ? error.message : "Subscription login failed"; flow.prompt = undefined; flow.answer = undefined; } });
    return this.view(flow);
  }

  get(id: string): AuthFlowView {
    const flow = this.flows.get(id);
    if (!flow) throw Object.assign(new Error("Unknown subscription login"), { statusCode: 404 });
    return this.view(flow);
  }

  answer(id: string, promptId: string, value: string): AuthFlowView {
    const flow = this.flows.get(id);
    if (!flow) throw Object.assign(new Error("Unknown subscription login"), { statusCode: 404 });
    if (flow.status !== "pending" || !flow.answer || flow.answer.promptId !== promptId) throw Object.assign(new Error("Subscription login prompt is no longer active"), { statusCode: 409 });
    if (typeof value !== "string" || !value.trim()) throw Object.assign(new Error("A response is required"), { statusCode: 400 });
    flow.answer.resolve(value.trim());
    return this.view(flow);
  }

  cancel(id: string): void {
    const flow = this.flows.get(id);
    if (!flow) throw Object.assign(new Error("Unknown subscription login"), { statusCode: 404 });
    if (flow.status !== "pending") return;
    flow.status = "cancelled";
    flow.answer?.reject(new Error("Login cancelled"));
    flow.controller.abort();
    flow.prompt = undefined;
  }

  private view(flow: Flow): AuthFlowView {
    return { id: flow.id, providerId: flow.providerId, status: flow.status, events: flow.events.map((event) => ({ ...event })), prompt: flow.prompt ? { ...flow.prompt, options: flow.prompt.options?.map((option) => ({ ...option })) } : undefined, error: flow.error };
  }
}
