const IMAGE_FILE = /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico|heic|heif|tiff?)$/i;
const displayToMarkdown = new Map<string, string>();

type TauriInternals = {
  convertFileSrc?: (path: string, protocol?: string) => string;
};

export function isImagePath(path: string) {
  return IMAGE_FILE.test(path.split(/[/\\]/).pop() ?? "");
}

export function markdownImage(label: string, markdownPath: string) {
  const alt = label.replace(/\.[^.]+$/, "").replace(/[\[\]\r\n]/g, " ").trim() || "image";
  return `![${alt}](${markdownPath})`;
}

export function restoreImageMarkdown(markdown: string) {
  let next = markdown;
  for (const [display, source] of displayToMarkdown) {
    if (next.includes(display)) next = next.split(display).join(source);
  }
  return next;
}

function isSpecialUrl(src: string) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(src);
}

export function resolveNoteAsset(projectPath: string, noteRelativePath: string, src: string) {
  if (!src || isSpecialUrl(src)) return null;
  let decoded = src;
  try {
    decoded = decodeURI(src);
  } catch {
    decoded = src;
  }
  const noteDir = noteRelativePath.replace(/\\/g, "/").split("/").slice(0, -1).filter(Boolean);
  const parts = [...noteDir];
  for (const segment of decoded.replace(/\\/g, "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return `${projectPath.replace(/[\\/]+$/, "")}/${parts.join("/")}`;
}

function imageSource(img: HTMLImageElement) {
  const marker = img.parentElement?.querySelector(":scope > .vditor-ir__marker--link");
  const marked = marker?.textContent?.replace(/\u200b/g, "").trim();
  if (marked) return marked;
  const stored = img.getAttribute("data-hs-path");
  if (stored) return stored;
  const src = img.getAttribute("src") ?? "";
  return src && !isSpecialUrl(src) ? src : "";
}

export function rewriteEditorImages(root: HTMLElement, projectPath: string | null, noteRelativePath: string) {
  const convertFileSrc = (window as Window & { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__?.convertFileSrc;
  if (!projectPath || !convertFileSrc) return;
  for (const img of root.querySelectorAll<HTMLImageElement>(".vditor-reset img")) {
    const source = imageSource(img);
    if (!source) continue;
    const absolute = resolveNoteAsset(projectPath, noteRelativePath, source);
    if (!absolute) continue;
    let display = "";
    try {
      display = convertFileSrc(absolute);
    } catch {
      continue;
    }
    if (!display || img.getAttribute("src") === display) continue;
    displayToMarkdown.set(display, source);
    img.setAttribute("data-hs-path", source);
    img.setAttribute("src", display);
  }
}
