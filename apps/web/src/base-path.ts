export function basePathFromDocumentUrl(url: string): string {
  const documentDirectory = new URL(".", url).pathname;
  return documentDirectory === "/" ? "" : documentDirectory.replace(/\/$/, "");
}

export const basePath = typeof document === "undefined" ? "" : basePathFromDocumentUrl(document.baseURI);

export function withBasePath(path: string): string {
  const absolutePath = path.startsWith("/") ? path : `/${path}`;
  return `${basePath}${absolutePath}`;
}
