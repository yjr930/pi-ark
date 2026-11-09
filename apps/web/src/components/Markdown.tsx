import DOMPurify from "dompurify";
import { marked } from "marked";
import { useMemo, type MouseEvent } from "react";

export function Markdown({ source, className = "", resolveImage, onImageOpen }: { source: string; className?: string; resolveImage?: (source: string) => string; onImageOpen?: (source: string, alt: string) => void }) {
  const html = useMemo(() => {
    const sanitized = DOMPurify.sanitize(marked.parse(source, { async: false }) as string);
    const document = new DOMParser().parseFromString(sanitized, "text/html");
    for (const image of document.querySelectorAll("img")) {
      const imageSource = image.getAttribute("src");
      if (imageSource && resolveImage) image.src = resolveImage(imageSource);
      image.loading = "lazy";
    }
    for (const link of document.querySelectorAll("a")) {
      link.target = "_blank";
      link.rel = "noreferrer noopener";
    }
    return document.body.innerHTML;
  }, [source, resolveImage]);

  function openImage(event: MouseEvent<HTMLElement>) {
    if (!onImageOpen || !(event.target instanceof HTMLImageElement)) return;
    onImageOpen(event.target.src, event.target.alt || "Image");
  }

  return <article className={`markdown-body ${className}`.trim()} onClick={openImage} dangerouslySetInnerHTML={{ __html: html }} />;
}
