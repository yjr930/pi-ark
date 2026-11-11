import { api } from "./api";
import { fileLocation } from "./permalinks";
import { deferFileLinks, FILE_LINK_DELAY_MS, FileLinkResolver, FileLinkWorkQueue, FileLinkTextSnapshot, localFileHref, type CancelFileLinkWork, type FilePathToken, type ResolvedFileLink } from "./file-links";

const resolver = new FileLinkResolver((workspaceId, paths, basePath) => api.resolveFileLinks(workspaceId, paths, basePath));
const work = new FileLinkWorkQueue((run) => {
  if (typeof window.requestIdleCallback === "function") {
    const id = window.requestIdleCallback(run, { timeout: 300 });
    return () => window.cancelIdleCallback(id);
  }
  const id = window.setTimeout(run, 16);
  return () => window.clearTimeout(id);
});
const nearby = new Map<Element, (visible: boolean) => void>();
let observer: IntersectionObserver | undefined;
function observeNearby(element: Element, callback: (visible: boolean) => void): CancelFileLinkWork {
  if (typeof IntersectionObserver === "undefined") { callback(true); return () => {}; }
  observer ??= new IntersectionObserver((entries) => {
    for (const entry of entries) nearby.get(entry.target)?.(entry.isIntersecting);
  }, { rootMargin: "200px" });
  nearby.set(element, callback);
  observer.observe(element);
  return () => { nearby.delete(element); observer?.unobserve(element); };
}

interface Candidate extends FilePathToken { result?: ResolvedFileLink }
interface TextScan {
  snapshot: FileLinkTextSnapshot<Text>;
  observer: MutationObserver;
  tailStart: number;
  tokens: FilePathToken[]; tokenIndex: number;
  batch?: { candidates: Candidate[]; waiting: number; writeIndex: number };
}
const skipped = new Set(["PRE", "IMG", "SVG", "MATH", "SCRIPT", "STYLE", "TEXTAREA", "BUTTON", "INPUT", "SELECT", "VIDEO", "AUDIO"]);

/** Runs only after React commits. Source is never rewritten or fed back to Markdown. */
export function enhanceFileLinks(article: HTMLElement, workspaceId: string, basePath: string): CancelFileLinkWork {
  let cancelled = false;
  let scanQueued = false;
  let scanCancel: CancelFileLinkWork | undefined;
  const pending = new Set<CancelFileLinkWork>();
  const writes = new Set<CancelFileLinkWork>();
  let cursor: Node | null = article.firstChild;
  let text: TextScan | undefined;
  let anchorScan: { anchor: HTMLAnchorElement; cursor: Node | null } | undefined;
  const valid = (node: Node) => !cancelled && article.isConnected && node.isConnected && article.contains(node);
  function queueWrite(write: () => void) {
    let cancel: CancelFileLinkWork;
    cancel = work.enqueue(() => { writes.delete(cancel); if (!cancelled) write(); return true; });
    writes.add(cancel);
  }
  function lookup(input: string, receive: (result: ResolvedFileLink | undefined) => void) {
    let completed = false;
    let cancel: CancelFileLinkWork = () => {};
    cancel = resolver.request(workspaceId, basePath, input, (result) => {
      completed = true;
      pending.delete(cancel);
      if (!cancelled) receive(result);
    });
    if (!completed) pending.add(cancel);
  }
  function setLink(anchor: HTMLAnchorElement, result: ResolvedFileLink) {
    anchor.href = fileLocation(workspaceId, result.path, result.type);
    anchor.dataset.piArkFileLink = "true";
    anchor.target = "_self";
    anchor.rel = "noreferrer noopener";
  }
  function resolveAnchor(anchor: HTMLAnchorElement) {
    if (anchor.dataset.piArkLink || anchor.dataset.piArkFileLink) return;
    const original = anchor.getAttribute("href") || "";
    const input = localFileHref(original);
    if (!input) return;
    lookup(input, (result) => {
      if (result) queueWrite(() => {
        if (valid(anchor) && anchor.getAttribute("href") === original) setLink(anchor, result);
      });
    });
  }
  function advance(node: Node, skipChildren = false, boundary: Node = article): Node | null {
    if (!skipChildren && node.firstChild) return node.firstChild;
    let next: Node | null = node;
    while (next && next !== boundary) {
      if (next.nextSibling) return next.nextSibling;
      next = next.parentNode;
    }
    return null;
  }
  function scheduleScan() {
    if (cancelled || scanQueued) return;
    scanQueued = true;
    scanCancel = work.enqueue(() => {
      if (cancelled) { scanQueued = false; return true; }
      const more = scanStep();
      if (!more) scanQueued = false;
      return !more;
    });
  }
  function scanText(state: TextScan): boolean {
    const snapshot = state.snapshot;
    if (state.observer.takeRecords().length) snapshot.invalidate();
    if (!valid(snapshot.node) || !snapshot.isCurrent()) {
      state.observer.disconnect();
      text = undefined;
      return true;
    }
    if (state.batch) {
      const batch = state.batch;
      if (batch.waiting) return false;
      const candidate = batch.candidates[batch.writeIndex++];
      if (candidate) {
        if (candidate.result && candidate.start >= state.tailStart) {
          const prefixLength = candidate.start - state.tailStart;
          // Ignore our own splits, then observe only the remaining Text node.
          state.observer.disconnect();
          const selected = prefixLength ? snapshot.node.splitText(prefixLength) : snapshot.node;
          const tail = selected.splitText(candidate.end - candidate.start);
          const anchor = document.createElement("a");
          setLink(anchor, candidate.result);
          // Existing inline code stays outside the anchor and retains its exact typography.
          anchor.style.font = "inherit";
          anchor.style.letterSpacing = "inherit";
          anchor.style.padding = "0";
          anchor.style.margin = "0";
          anchor.style.border = "0";
          anchor.style.background = "transparent";
          anchor.append(selected.cloneNode());
          selected.replaceWith(anchor);
          snapshot.useTail(tail);
          state.observer.observe(tail, { characterData: true });
          state.tailStart = candidate.end;
        }
        return true;
      }
      state.batch = undefined;
    }
    if (state.tokenIndex < state.tokens.length) {
      const candidates = state.tokens.slice(state.tokenIndex, state.tokenIndex + 32).map((token) => ({ ...token }));
      state.tokenIndex += candidates.length;
      const batch = { candidates, waiting: candidates.length, writeIndex: 0 };
      state.batch = batch;
      for (const candidate of candidates) lookup(candidate.input, (result) => {
        if (text !== state) return;
        (candidate as Candidate).result = result;
        batch.waiting -= 1;
        if (!batch.waiting) scheduleScan();
      });
      return batch.waiting === 0;
    }
    if (!snapshot.scanner.done) {
      state.tokens = snapshot.scanner.step();
      state.tokenIndex = 0;
      return true;
    }
    state.observer.disconnect();
    text = undefined;
    return true;
  }
  function scanStep(): boolean {
    if (text) return scanText(text);
    if (anchorScan) {
      const state = anchorScan;
      if (!valid(state.anchor)) { anchorScan = undefined; return true; }
      for (let count = 0; state.cursor && count < 16; count += 1) {
        if (state.cursor instanceof HTMLImageElement) { anchorScan = undefined; return true; }
        state.cursor = advance(state.cursor, false, state.anchor);
      }
      if (!state.cursor) { resolveAnchor(state.anchor); anchorScan = undefined; }
      return true;
    }
    // Bound both element traversal and text matching; a giant Text node uses many steps.
    for (let count = 0; cursor && count < 16; count += 1) {
      const node = cursor;
      if (!valid(node)) { cursor = null; break; }
      if (node instanceof HTMLElement && node.tagName === "A") {
        cursor = advance(node, true);
        if (!node.dataset.piArkLink && !node.dataset.piArkFileLink && localFileHref(node.getAttribute("href") || "")) {
          anchorScan = { anchor: node as HTMLAnchorElement, cursor: node.firstChild };
          return true;
        }
      } else if (node instanceof Element && skipped.has(node.tagName)) {
        cursor = advance(node, true);
      } else {
        cursor = advance(node);
        if (node instanceof Text && node.length) {
          const snapshot = new FileLinkTextSnapshot(node, node.parentElement?.tagName === "CODE");
          const observer = new MutationObserver(() => { snapshot.invalidate(); scheduleScan(); });
          observer.observe(node, { characterData: true });
          text = { snapshot, observer, tailStart: 0, tokens: [], tokenIndex: 0 };
          return true;
        }
      }
    }
    return Boolean(cursor);
  }

  // A local href must never send the browser to a relative route before confirmation.
  // Confirmed anchors bypass this handler and keep native modifier-key behavior.
  function intercept(event: MouseEvent) {
    if (event.defaultPrevented || event.button > 1 || !(event.target instanceof Element) || event.target instanceof HTMLImageElement) return;
    const anchor = event.target.closest<HTMLAnchorElement>("a");
    if (!anchor || !article.contains(anchor) || anchor.dataset.piArkLink || anchor.dataset.piArkFileLink) return;
    const original = anchor.getAttribute("href") || "";
    const input = localFileHref(original);
    if (!input) return;
    event.preventDefault();
    event.stopPropagation();
    const newTab = event.ctrlKey || event.metaKey || event.shiftKey || event.button === 1;
    lookup(input, (result) => {
      if (!result) return;
      queueWrite(() => {
        if (!valid(anchor)) return;
        const href = fileLocation(workspaceId, result.path, result.type);
        if (anchor.getAttribute("href") !== original && !(anchor.dataset.piArkFileLink && anchor.href === new URL(href, window.location.href).href)) return;
        setLink(anchor, result);
        if (newTab) window.open(anchor.href, "_blank", "noopener,noreferrer");
        else anchor.click();
      });
    });
  }
  article.addEventListener("click", intercept, true);
  article.addEventListener("auxclick", intercept, true);
  const committedAt = performance.now();
  let delay: CancelFileLinkWork | undefined;
  let started = false;
  const unobserve = observeNearby(article, (visible) => {
    if (started) return;
    delay?.();
    delay = undefined;
    if (visible) delay = deferFileLinks(() => { started = true; scheduleScan(); }, undefined, Math.max(0, FILE_LINK_DELAY_MS - (performance.now() - committedAt)));
  });
  return () => {
    cancelled = true;
    unobserve();
    delay?.();
    scanCancel?.();
    text?.observer.disconnect();
    for (const cancel of writes) cancel();
    for (const cancel of pending) cancel();
    article.removeEventListener("click", intercept, true);
    article.removeEventListener("auxclick", intercept, true);
  };
}
