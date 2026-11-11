import DOMPurify from "dompurify";
import { marked } from "marked";
import { createContext, useContext, useEffect, useMemo, useRef, type MouseEvent } from "react";
import { parseInternalSessionLink, sessionPermalink } from "../permalinks";
import { FileLinksContext } from "../file-links";
import { enhanceFileLinks } from "../file-link-dom";

export const MarkdownLineBreaksContext = createContext(true);

export function Markdown({ source, className = "", resolveImage, onImageOpen, fileBasePath = "" }: { source: string; className?: string; resolveImage?: (source: string) => string; onImageOpen?: (source: string, alt: string) => void; fileBasePath?: string }) {
  const markdownLineBreaks = useContext(MarkdownLineBreaksContext);
  const fileLinks = useContext(FileLinksContext);
  const article = useRef<HTMLElement>(null);
  const html = useMemo(() => {
    const parsed = new DOMParser().parseFromString(marked.parse(source, { async: false, breaks: markdownLineBreaks }) as string, "text/html");
    for (const link of parsed.querySelectorAll("a")) {
      const original = link.getAttribute("href") || "";
      const target = parseInternalSessionLink(original);
      if (target) {
        link.href = sessionPermalink(target.workspaceId, target.sessionId, target.messageId, target.leafEntryId);
        link.dataset.piArkLink = original;
      }
    }
    const sanitized = DOMPurify.sanitize(parsed.body.innerHTML);
    const document = new DOMParser().parseFromString(sanitized, "text/html");
    for (const image of document.querySelectorAll("img")) {
      const imageSource = image.getAttribute("src");
      if (imageSource && resolveImage) image.src = resolveImage(imageSource);
      image.loading = "lazy";
    }
    for (const link of document.querySelectorAll("a")) {
      link.target = link.dataset.piArkLink ? "_self" : "_blank";
      link.rel = "noreferrer noopener";
    }
    return document.body.innerHTML;
  }, [source, resolveImage, markdownLineBreaks]);

  useEffect(() => {
    if (article.current && fileLinks?.workspaceId) return enhanceFileLinks(article.current, fileLinks.workspaceId, fileBasePath);
  }, [source, html, fileLinks?.workspaceId, fileBasePath]);

  function openImage(event: MouseEvent<HTMLElement>) {
    if (!onImageOpen || !(event.target instanceof HTMLImageElement)) return;
    onImageOpen(event.target.src, event.target.alt || "Image");
  }

  return <article key={JSON.stringify([fileLinks?.workspaceId, fileBasePath])} ref={article} className={`markdown-body ${className}`.trim()} onClick={openImage} dangerouslySetInnerHTML={{ __html: html }} />;
}
