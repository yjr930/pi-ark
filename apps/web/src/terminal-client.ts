import { Terminal as XTerminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { websocketUrl } from "./api";
import type { TerminalAppearance } from "./terminal-preferences";
import type { TerminalInfo } from "./types";

export type TerminalConnection = "connecting" | "connected" | "reconnecting" | "disconnected" | "exited" | "closed";
export type TerminalClientState = { connection: TerminalConnection; hasSelection: boolean; message: string };
type Callbacks = {
  onState: (state: TerminalClientState) => void;
  onInfo: (info: TerminalInfo) => void;
  onClosed: () => void;
  onNotice: (message: string, error: boolean) => void;
};

export class TerminalClient {
  readonly terminal: XTerminal;
  private readonly fitAddon = new FitAddon();
  private socket: WebSocket | null = null;
  private retryTimer: number | undefined;
  private fitFrame: number | undefined;
  private retries = 0;
  private offset = 0;
  private ready = false;
  private disposed = false;
  private closing = false;
  private remotelyClosed = false;
  private active = false;
  private composing = false;
  private lastSize = "";
  private state: TerminalClientState = { connection: "connecting", hasSelection: false, message: "" };
  private readonly disposers: Array<() => void> = [];

  constructor(private readonly host: HTMLDivElement, private readonly workspaceId: string, private info: TerminalInfo, appearance: TerminalAppearance, private readonly callbacks: Callbacks) {
    this.terminal = new XTerminal({ cols: info.cols, rows: info.rows, cursorBlink: true, fontFamily: appearance.fontFamily, fontSize: appearance.fontSize, lineHeight: 1.35, scrollback: 100000, allowTransparency: true, theme: this.theme() });
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.open(host);
    this.terminal.textarea?.setAttribute("aria-label", `Terminal input: ${info.title}`);
    this.terminal.attachCustomKeyEventHandler((event) => this.handleKey(event));
    const input = this.terminal.onData((data) => this.sendInput(data));
    const selection = this.terminal.onSelectionChange(() => this.updateState({ hasSelection: this.terminal.hasSelection() }));
    const observer = new ResizeObserver(() => this.scheduleFit());
    observer.observe(host);
    const themeObserver = new MutationObserver(() => { this.terminal.options.theme = this.theme(); });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style"] });
    const beginComposition = () => { this.composing = true; };
    const endComposition = () => { this.composing = false; };
    host.addEventListener("compositionstart", beginComposition, true);
    host.addEventListener("compositionend", endComposition, true);
    const fontsLoaded = () => this.scheduleFit();
    document.fonts.addEventListener("loadingdone", fontsLoaded);
    void document.fonts.ready.then(() => { if (!this.disposed) this.scheduleFit(); });
    const online = () => { if (!this.ready && !this.closing && !this.remotelyClosed) this.retry(); };
    window.addEventListener("online", online);
    this.disposers.push(() => input.dispose(), () => selection.dispose(), () => observer.disconnect(), () => themeObserver.disconnect(), () => host.removeEventListener("compositionstart", beginComposition, true), () => host.removeEventListener("compositionend", endComposition, true), () => document.fonts.removeEventListener("loadingdone", fontsLoaded), () => window.removeEventListener("online", online));
    queueMicrotask(() => this.connect());
  }

  private theme() {
    const style = getComputedStyle(this.host);
    const value = (name: string) => style.getPropertyValue(name).trim();
    return { background: value("--input"), foreground: value("--text-soft"), cursor: value("--accent"), selectionBackground: value("--hover"), selectionInactiveBackground: value("--surface-3") };
  }

  private updateState(update: Partial<TerminalClientState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...update };
    this.callbacks.onState(this.state);
  }

  private handleKey(event: KeyboardEvent): boolean {
    if (this.composing || event.isComposing || event.keyCode === 229) return true;
    const key = event.key.toLowerCase();
    const copy = key === "c" && !event.altKey && ((event.ctrlKey && event.shiftKey && !event.metaKey) || (event.metaKey && !event.ctrlKey));
    if (copy) {
      event.preventDefault();
      if (event.type === "keydown") void this.copy();
      return false;
    }
    return true;
  }

  private canInput(): boolean {
    return !this.disposed && !this.closing && !this.remotelyClosed && this.ready && this.info.status === "running" && this.socket?.readyState === WebSocket.OPEN;
  }

  private sendInput(data: string) {
    if (!this.canInput()) {
      this.callbacks.onNotice(this.info.status === "exited" ? "This terminal has exited. Create a new tab to run commands." : "Input was not sent. Reconnect the terminal before typing or pasting.", true);
      return;
    }
    try { this.socket!.send(JSON.stringify({ type: "input", data })); }
    catch { this.callbacks.onNotice("Input was not sent because the connection closed. Reconnect and enter the command again.", true); }
  }

  async copy() {
    const text = this.terminal.getSelection();
    if (!text) { this.callbacks.onNotice("Select terminal text to copy.", true); return; }
    try {
      await navigator.clipboard.writeText(text);
      if (!this.disposed) this.callbacks.onNotice("Terminal selection copied.", false);
    } catch (reason) {
      if (!this.disposed) this.callbacks.onNotice(`Cannot copy terminal selection: ${reason instanceof Error ? reason.message : "Clipboard access is unavailable"}`, true);
    }
  }

  async paste() {
    if (!this.canInput()) { this.callbacks.onNotice("Reconnect a running terminal before pasting.", true); return; }
    try {
      const text = await navigator.clipboard.readText();
      if (this.disposed) return;
      if (!this.canInput()) { this.callbacks.onNotice("Clipboard text was not sent because the terminal connection changed. Reconnect and paste again.", true); return; }
      this.terminal.paste(text);
      this.terminal.focus();
    } catch (reason) {
      if (!this.disposed) this.callbacks.onNotice(`Cannot read clipboard: ${reason instanceof Error ? reason.message : "Clipboard access is unavailable"}. Use the browser Paste command.`, true);
    }
  }

  setActive(active: boolean) {
    this.active = active;
    if (active) {
      this.terminal.options.theme = this.theme();
      this.scheduleFit();
      if (document.activeElement === document.body) this.terminal.focus();
    } else this.terminal.blur();
  }

  setAppearance(appearance: TerminalAppearance) {
    if (this.terminal.options.fontFamily === appearance.fontFamily && this.terminal.options.fontSize === appearance.fontSize) return;
    this.terminal.options.fontFamily = appearance.fontFamily;
    this.terminal.options.fontSize = appearance.fontSize;
    this.scheduleFit();
    void document.fonts.ready.then(() => { if (!this.disposed) this.scheduleFit(); });
  }

  setClosing(closing: boolean) {
    if (closing === this.closing) return;
    this.closing = closing;
    if (closing) window.clearTimeout(this.retryTimer);
    else if (!this.ready && !this.remotelyClosed) this.retry();
  }

  private scheduleFit() {
    if (this.disposed || !this.active || this.fitFrame !== undefined) return;
    this.fitFrame = window.requestAnimationFrame(() => { this.fitFrame = undefined; this.fit(); });
  }

  fit() {
    if (this.disposed || !this.active || !this.host.isConnected || this.host.clientWidth < 30 || this.host.clientHeight < 30 || !this.host.getClientRects().length) return;
    const dimensions = this.fitAddon.proposeDimensions();
    if (!dimensions || !Number.isFinite(dimensions.cols) || !Number.isFinite(dimensions.rows) || dimensions.cols < 2 || dimensions.rows < 1) return;
    const buffer = this.terminal.buffer.active;
    const viewport = buffer.viewportY;
    const atBottom = viewport >= buffer.baseY;
    if (this.terminal.cols !== dimensions.cols || this.terminal.rows !== dimensions.rows) {
      this.fitAddon.fit();
      if (atBottom) this.terminal.scrollToBottom();
      else this.terminal.scrollToLine(viewport);
    }
    const size = `${this.terminal.cols}:${this.terminal.rows}`;
    if (this.canInput() && size !== this.lastSize) {
      this.socket!.send(JSON.stringify({ type: "resize", cols: this.terminal.cols, rows: this.terminal.rows }));
      this.lastSize = size;
    }
  }

  retry() {
    if (this.disposed || this.closing || this.remotelyClosed) return;
    window.clearTimeout(this.retryTimer);
    this.socket?.close();
    this.socket = null;
    this.retries = 0;
    this.connect();
  }

  private receive(data: string, offset: number) {
    const start = offset - data.length;
    if (start > this.offset) {
      this.updateState({ message: "Output connection interrupted. Recovering terminal history…" });
      this.socket?.close();
      return;
    }
    if (offset <= this.offset) return;
    this.terminal.write(data.slice(Math.max(0, this.offset - start)));
    this.offset = offset;
  }

  private connect() {
    if (this.disposed || this.closing || this.remotelyClosed) return;
    this.ready = false;
    this.lastSize = "";
    this.updateState({ connection: this.retries ? "reconnecting" : "connecting" });
    const socket = new WebSocket(websocketUrl(`/ws/terminal/${encodeURIComponent(this.workspaceId)}/${encodeURIComponent(this.info.id)}?offset=${this.offset}`));
    this.socket = socket;
    socket.onmessage = (event) => {
      if (this.disposed || socket !== this.socket) return;
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === "ready") {
          this.info = payload.terminal;
          this.receive(payload.data, payload.offset);
          if (socket.readyState !== WebSocket.OPEN) return;
          this.ready = true;
          this.retries = 0;
          this.callbacks.onInfo(this.info);
          this.updateState({ connection: this.info.status === "exited" ? "exited" : "connected", message: "" });
          this.scheduleFit();
        } else if (payload.type === "output") {
          this.receive(payload.data, payload.offset);
        } else if (payload.type === "exit") {
          this.info = { ...this.info, status: "exited", exitCode: payload.exitCode };
          this.callbacks.onInfo(this.info);
          this.updateState({ connection: "exited", message: "" });
        } else if (payload.type === "closed") {
          this.remotelyClosed = true;
          this.ready = false;
          window.clearTimeout(this.retryTimer);
          this.updateState({ connection: "closed", message: "This terminal was closed." });
          if (!this.closing) this.callbacks.onClosed();
        } else if (payload.type === "error") {
          this.updateState({ message: payload.message });
        }
      } catch {
        this.updateState({ message: "Cannot read the terminal response. Reconnecting…" });
        socket.close();
      }
    };
    socket.onerror = () => {
      if (socket !== this.socket || this.disposed) return;
      this.updateState({ message: "Terminal connection failed. Retrying automatically…" });
      socket.close();
    };
    socket.onclose = (event) => {
      if (socket !== this.socket || this.disposed) return;
      this.ready = false;
      if (this.remotelyClosed || this.closing) return;
      if (this.info.status === "exited") { this.updateState({ connection: "exited" }); return; }
      if (event.code === 1008) { this.updateState({ connection: "disconnected", message: this.state.message || "Terminal connection was rejected. Retry to reconnect." }); return; }
      this.updateState({ connection: "reconnecting", message: this.state.message || "Connection lost. Terminal history will resume after reconnecting." });
      const delay = Math.min(10000, 500 * 2 ** Math.min(this.retries++, 5));
      this.retryTimer = window.setTimeout(() => this.connect(), delay);
    };
  }

  dispose() {
    this.disposed = true;
    window.clearTimeout(this.retryTimer);
    if (this.fitFrame !== undefined) window.cancelAnimationFrame(this.fitFrame);
    this.socket?.close();
    this.disposers.forEach((dispose) => dispose());
    this.terminal.dispose();
  }
}
