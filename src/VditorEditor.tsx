import { useEffect, useRef, useState } from "react";
import Vditor from "vditor";
import "vditor/dist/index.css";
import {
  createHyperSpaceRenderer,
  insertHyperSpaceEmbed,
  refreshHyperSpaceEmbeds,
  type HyperSpaceEmbedContext,
} from "./hyperspaceEmbeds";
import {
  annotateHeadingElements,
  parseMarkdownHeadings,
} from "./markdownNavigation";
import type { ContentNode } from "./types";
import { installVditorContractIcon, withLucideToolbarIcons } from "./vditorToolbarIcons";

export interface HyperSpaceVditorProps {
  pageId: string;
  value: string;
  nodes: ContentNode[];
  readOnly: boolean;
  theme?: "light" | "dark";
  onChange: (markdown: string) => void;
  onNavigateNode: (nodeId: string) => void;
  onActiveHeadingChange?: (headingId: string | null) => void;
  onCursorChange?: (position: { line: number; column: number }) => void;
}

const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HYPERSPACE_NODE_LINK = /^hyperspace:\/\/node\/([^/?#]+)/i;

const REQUIRED_ASSETS = [
  "dist/index.css",
  "dist/js/lute/lute.min.js",
  "dist/js/i18n/zh_CN.js",
  "dist/js/icons/ant.js",
  "dist/js/highlight.js/highlight.min.js",
  "dist/js/katex/katex.min.js",
  "dist/js/katex/fonts/KaTeX_Main-Regular.woff2",
  "dist/js/mermaid/mermaid.min.js",
];

function vditorCdn() {
  return new URL("vendor/vditor", document.baseURI).href.replace(/\/$/, "");
}

async function assertVditorAssets(cdn: string) {
  const missing: string[] = [];
  await Promise.all(REQUIRED_ASSETS.map(async (asset) => {
    try {
      const url = `${cdn}/${asset}`;
      const head = await fetch(url, { method: "HEAD" });
      if (head.ok) return;
      const get = await fetch(url, { method: "GET" });
      if (!get.ok) missing.push(asset);
    } catch {
      missing.push(asset);
    }
  }));
  if (missing.length) {
    throw new Error(`缺少本地 Vditor 资源：${missing.join(", ")}`);
  }
}

/** Vditor writes shortcuts as "标题 <⌘H>"; this build also disables its own tooltips. */
const SHORTCUT_SUFFIX = /^(.*?)\s*<([^<>]+)>\s*$/;

function titleFromLabel(label: string) {
  const match = label.match(SHORTCUT_SUFFIX);
  return match ? `${match[1]} ${match[2]}` : label;
}

function decorateToolbar(root: HTMLElement) {
  for (const button of root.querySelectorAll<HTMLElement>(".vditor-toolbar button[aria-label]")) {
    button.title = titleFromLabel(button.getAttribute("aria-label") ?? "");
  }
  for (const button of root.querySelectorAll<HTMLElement>(".vditor-toolbar .vditor-hint > button")) {
    const match = button.textContent?.match(SHORTCUT_SUFFIX);
    if (!match || button.firstElementChild) continue;
    const name = document.createElement("span");
    name.textContent = match[1];
    const shortcut = document.createElement("kbd");
    shortcut.textContent = match[2];
    button.replaceChildren(name, shortcut);
  }
}

/** wysiwyg rebuilds the block popover on every caret move, so it is decorated
    from a mutation rather than once at startup. */
function decoratePopovers(root: HTMLElement) {
  for (const control of root.querySelectorAll<HTMLElement>(".vditor-panel [aria-label]")) {
    control.title = titleFromLabel(control.getAttribute("aria-label") ?? "");
  }
}

function headingIdFromCaret(root: HTMLElement): string | null {
  const selection = document.getSelection();
  if (!selection?.focusNode) return null;
  const focusElement = selection.focusNode instanceof Element
    ? selection.focusNode
    : selection.focusNode.parentElement;
  if (!focusElement || !root.contains(focusElement)) return null;

  const current = focusElement.closest<HTMLElement>("h1, h2, h3, h4, h5, h6");
  if (current?.dataset.hsHeadingId) return current.dataset.hsHeadingId;

  const headings = Array.from(root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6"));
  const caretRange = document.createRange();
  caretRange.selectNodeContents(root);
  try {
    caretRange.setEnd(selection.focusNode, selection.focusOffset);
  } catch {
    return null;
  }

  let last: string | null = null;
  for (const heading of headings) {
    const headingRange = document.createRange();
    headingRange.selectNode(heading);
    if (caretRange.compareBoundaryPoints(Range.START_TO_START, headingRange) < 0) break;
    last = heading.dataset.hsHeadingId ?? last;
  }
  return last;
}

function cursorFromTextarea(textarea: HTMLTextAreaElement) {
  const beforeCursor = textarea.value.slice(0, textarea.selectionStart ?? 0);
  const lines = beforeCursor.split("\n");
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

function cursorFromEditable(root: HTMLElement, selection: Selection) {
  if (!selection.focusNode) return null;
  const range = document.createRange();
  range.selectNodeContents(root);
  try {
    range.setEnd(selection.focusNode, selection.focusOffset);
  } catch {
    return null;
  }
  const lines = range.toString().replace(/\r\n?/g, "\n").split("\n");
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

function openExternalUrl(href: string) {
  window.open(href, "_blank", "noopener,noreferrer");
}

const ZWSP = "\u200b";

function visibleText(value: string) {
  return value.replaceAll(ZWSP, "").replace(/\n+$/g, "").trim();
}

function markdownEquals(left: string, right: string) {
  return left === right || left.replace(/\n+$/, "") === right.replace(/\n+$/, "");
}

function editorSurface(root: HTMLElement) {
  return root.querySelector<HTMLElement>(
    ".vditor-ir pre.vditor-reset, .vditor-wysiwyg pre.vditor-reset",
  );
}

function isEmptyParagraph(element: Element | null): element is HTMLElement {
  return Boolean(element && element.tagName === "P" && visibleText(element.textContent ?? "") === "");
}

function isEmptyListItem(element: HTMLElement) {
  return visibleText(element.textContent ?? "") === ""
    && !element.querySelector("pre, table, ul, ol, img, hr");
}

function lastContentBlock(surface: HTMLElement) {
  let element = surface.lastElementChild;
  while (element && isEmptyParagraph(element)) element = element.previousElementSibling;
  return element;
}

function createEmptyParagraph() {
  const paragraph = document.createElement("p");
  paragraph.setAttribute("data-block", "0");
  paragraph.textContent = ZWSP;
  return paragraph;
}

function placeCaretIn(element: HTMLElement) {
  const selection = document.getSelection();
  if (!selection) return;
  const node = element.firstChild ?? element;
  const range = document.createRange();
  if (node.nodeType === Node.TEXT_NODE) {
    range.setStart(node, Math.min(1, node.textContent?.length ?? 0));
  } else {
    range.selectNodeContents(element);
  }
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

function closestElement(node: Node, selector: string) {
  const element = node instanceof Element ? node : node.parentElement;
  return element?.closest<HTMLElement>(selector) ?? null;
}

function caretAtEndOf(block: Element, range: Range) {
  const after = document.createRange();
  try {
    after.selectNodeContents(block);
    after.setStart(range.endContainer, range.endOffset);
  } catch {
    return false;
  }
  const leftover = after.cloneContents();
  leftover.querySelectorAll(".vditor-ir__marker, wbr").forEach((node) => node.remove());
  return visibleText(leftover.textContent ?? "") === "";
}

function nextListMarker(list: HTMLElement, item: HTMLElement) {
  const current = item.getAttribute("data-marker") ?? list.getAttribute("data-marker") ?? "";
  const numbered = current.match(/^(\d+)([.)])$/);
  if (numbered) return `${Number(numbered[1]) + 1}${numbered[2]}`;
  if (list.tagName === "OL") return `${list.children.length + 1}.`;
  return current || "*";
}

function insertListItemAfter(listItem: HTMLElement) {
  const list = listItem.parentElement;
  if (!list) return null;
  const item = document.createElement("li");
  item.setAttribute("data-marker", nextListMarker(list, listItem));
  if (listItem.classList.contains("vditor-task")) {
    item.classList.add("vditor-task");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    item.append(checkbox, document.createTextNode(" "));
  }
  const paragraph = createEmptyParagraph();
  item.append(paragraph);
  listItem.after(item);
  placeCaretIn(paragraph);
  return item;
}

function exitEmptyListItem(listItem: HTMLElement, surface: HTMLElement) {
  const list = listItem.parentElement;
  if (!list) return;
  const parentItem = list.parentElement?.closest("li");
  if (list.childElementCount === 1) list.remove();
  else listItem.remove();
  if (parentItem instanceof HTMLElement) {
    const paragraph = createEmptyParagraph();
    parentItem.append(paragraph);
    placeCaretIn(paragraph);
    return;
  }
  const paragraph = isEmptyParagraph(surface.lastElementChild)
    ? surface.lastElementChild
    : surface.appendChild(createEmptyParagraph());
  placeCaretIn(paragraph);
}

function ensureTrailingParagraph(root: HTMLElement) {
  const surface = editorSurface(root);
  if (!surface || surface.childElementCount === 0) return;
  const last = surface.lastElementChild;
  const content = lastContentBlock(surface);
  if (content?.matches("ul, ol")) {
    if (isEmptyParagraph(last) && last !== content) last.remove();
    return;
  }
  if (isEmptyParagraph(last)) return;
  surface.append(createEmptyParagraph());
}

function isProtectedEnterTarget(node: Node) {
  const element = node instanceof Element ? node : node.parentElement;
  return Boolean(element?.closest(
    '[data-type="code-block"], [data-type="yaml-front-matter"], [data-type="math-block"], [data-type="html-block"], td, th, .vditor-ir__marker--pre',
  ));
}

function consumeEnter(event: KeyboardEvent) {
  event.preventDefault();
  event.stopImmediatePropagation();
}

/** Lute drops trailing empty blocks, so Enter at the document end is a no-op. */
function handleEnterAtDocumentEnd(event: KeyboardEvent, root: HTMLElement) {
  if (event.key !== "Enter" || event.isComposing || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) {
    return false;
  }
  const surface = editorSurface(root);
  if (!surface) return false;
  const selection = document.getSelection();
  if (!selection?.rangeCount || !selection.isCollapsed) return false;
  const range = selection.getRangeAt(0);
  if (!surface.contains(range.startContainer) || isProtectedEnterTarget(range.startContainer)) return false;

  const trailing = surface.lastElementChild;
  const listItem = closestElement(range.startContainer, "li");
  const paragraph = closestElement(range.startContainer, "p");

  if (!listItem && isEmptyParagraph(trailing) && trailing.contains(range.startContainer)) {
    const previous = trailing.previousElementSibling;
    if (previous?.matches("ul, ol") && previous.lastElementChild instanceof HTMLElement) {
      consumeEnter(event);
      insertListItemAfter(previous.lastElementChild);
      trailing.remove();
      return true;
    }
  }

  if (listItem?.parentElement?.matches("ul, ol")) {
    if (isEmptyListItem(listItem) && !listItem.nextElementSibling) {
      consumeEnter(event);
      exitEmptyListItem(listItem, surface);
      return true;
    }
    const atEndOfParagraph = Boolean(paragraph && listItem.contains(paragraph) && caretAtEndOf(paragraph, range));
    const atEndOfItem = caretAtEndOf(listItem, range);
    if (paragraph?.nextElementSibling && !atEndOfItem) return false;
    if (atEndOfParagraph || atEndOfItem) {
      consumeEnter(event);
      insertListItemAfter(listItem);
      return true;
    }
    return false;
  }

  const content = lastContentBlock(surface);
  if (!content || !content.contains(range.endContainer) || !caretAtEndOf(content, range)) return false;

  consumeEnter(event);
  const next = isEmptyParagraph(surface.lastElementChild)
    ? surface.lastElementChild
    : surface.appendChild(createEmptyParagraph());
  placeCaretIn(next);
  return true;
}

export function HyperSpaceVditor({
  pageId,
  value,
  nodes,
  readOnly,
  theme = "light",
  onChange,
  onNavigateNode,
  onActiveHeadingChange,
  onCursorChange,
}: HyperSpaceVditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<Vditor | null>(null);
  const readyRef = useRef(false);
  const valueRef = useRef(value);
  const nodesRef = useRef(nodes);
  const readOnlyRef = useRef(readOnly);
  const themeRef = useRef(theme);
  const onChangeRef = useRef(onChange);
  const onNavigateRef = useRef(onNavigateNode);
  const onHeadingRef = useRef(onActiveHeadingChange);
  const onCursorRef = useRef(onCursorChange);
  const applyingExternalRef = useRef(false);
  const rebuildOnceRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [rebuildKey, setRebuildKey] = useState(0);
  const [ready, setReady] = useState(false);

  valueRef.current = value;
  nodesRef.current = nodes;
  readOnlyRef.current = readOnly;
  themeRef.current = theme;
  onChangeRef.current = onChange;
  onNavigateRef.current = onNavigateNode;
  onHeadingRef.current = onActiveHeadingChange;
  onCursorRef.current = onCursorChange;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let instance: Vditor | null = null;
    const cdn = vditorCdn();
    const mount = document.createElement("div");
    mount.className = "hyperspace-vditor__mount";
    host.replaceChildren(mount);
    setReady(false);

    const context: HyperSpaceEmbedContext = {
      getNodes: () => nodesRef.current,
      onNavigateNode: (nodeId) => onNavigateRef.current(nodeId),
    };

    const destroyMount = (target?: Vditor | null) => {
      readyRef.current = false;
      try { target?.destroy(); } catch { /* already destroyed */ }
      if (instanceRef.current === target) instanceRef.current = null;
      mount.remove();
    };

    const refreshDerived = () => {
      if (disposed) return;
      refreshHyperSpaceEmbeds(mount, context);
      annotateHeadingElements(mount, valueRef.current);
      ensureTrailingParagraph(mount);
    };

    const reportCaret = () => {
      if (disposed) return;
      onHeadingRef.current?.(headingIdFromCaret(mount));
      const selection = document.getSelection();
      const textarea = mount.querySelector<HTMLTextAreaElement>("textarea");
      if (textarea && document.activeElement === textarea) {
        onCursorRef.current?.(cursorFromTextarea(textarea));
        return;
      }
      if (selection?.rangeCount && selection.focusNode && mount.contains(selection.focusNode)) {
        const editable = (selection.focusNode instanceof Element ? selection.focusNode : selection.focusNode.parentElement)
          ?.closest<HTMLElement>("[contenteditable='true'], .vditor-ir, .vditor-wysiwyg, .vditor-sv");
        const position = editable ? cursorFromEditable(editable, selection) : null;
        if (position) onCursorRef.current?.(position);
      }
    };

    const handleLink = (rawHref: string) => {
      const href = rawHref.trim();
      if (!href) return;
      const hyperspace = href.match(HYPERSPACE_NODE_LINK);
      if (hyperspace) {
        const nodeId = decodeURIComponent(hyperspace[1]);
        if (NODE_ID_PATTERN.test(nodeId)) onNavigateRef.current(nodeId);
        return;
      }
      if (/^https?:\/\//i.test(href)) {
        openExternalUrl(href);
        return;
      }
    };

    const boot = async () => {
      try {
        await assertVditorAssets(cdn);
        if (disposed) return;
        instance = new Vditor(mount, {
          value: valueRef.current,
          mode: "ir",
          lang: "zh_CN",
          height: "auto",
          minHeight: 320,
          placeholder: "开始记录…",
          theme: themeRef.current === "dark" ? "dark" : "classic",
          cache: { enable: false },
          cdn,
          toolbarConfig: { pin: true, hide: false },
          fullscreen: { index: 200 },
          toolbar: withLucideToolbarIcons([
            "headings", "bold", "italic", "strike", "|",
            "list", "ordered-list", "check", "quote", "|",
            "code", "inline-code", "link", "table",
            {
              name: "hyperspace-file",
              tip: "嵌入文件",
              click: () => {
                if (instanceRef.current) insertHyperSpaceEmbed(instanceRef.current, "file", nodesRef.current);
              },
            },
            {
              name: "hyperspace-folder",
              tip: "嵌入文件夹",
              click: () => {
                if (instanceRef.current) insertHyperSpaceEmbed(instanceRef.current, "folder", nodesRef.current);
              },
            },
            "|", "undo", "redo", "edit-mode", "both", "preview", "outline", "fullscreen",
          ]),
          preview: {
            delay: 300,
            maxWidth: 700,
            hljs: { enable: true, lineNumber: true },
            math: { engine: "KaTeX" },
            markdown: { mark: true, sup: true, sub: true, sanitize: true, toc: false },
            // An empty content theme stops Vditor from appending its GitHub
            // stylesheets to <head>, where they would outrank styles.css.
            theme: { current: "" },
            parse: () => refreshDerived(),
          },
          hint: { emojiPath: `${cdn}/dist/images/emoji` },
          link: {
            isOpen: false,
            click: (element) => {
              handleLink(element.getAttribute("href") ?? element.textContent ?? "");
            },
          },
          customRenders: [createHyperSpaceRenderer(context)],
          after: () => {
            if (disposed) {
              destroyMount(instance);
              return;
            }
            instanceRef.current = instance;
            if (readOnlyRef.current) instance?.disabled();
            else instance?.enable();
            // Only the chrome theme; passing a content or code theme would
            // re-inject the stylesheets suppressed above.
            instance?.setTheme(themeRef.current === "dark" ? "dark" : "classic");
            applyingExternalRef.current = true;
            try {
              instance?.setValue(valueRef.current, true);
            } catch {
              /* setValue can throw before lute is fully ready */
            }
            refreshDerived();
            installVditorContractIcon();
            decorateToolbar(mount);
            readyRef.current = true;
            setReady(true);
            setError(null);
            window.setTimeout(() => {
              if (!disposed) applyingExternalRef.current = false;
            }, 80);
          },
          input: (markdown) => {
            if (disposed || !readyRef.current || applyingExternalRef.current) return;
            if (markdownEquals(markdown, valueRef.current)) {
              window.requestAnimationFrame(refreshDerived);
              return;
            }
            valueRef.current = markdown;
            onChangeRef.current(markdown);
            window.requestAnimationFrame(() => {
              refreshDerived();
              reportCaret();
            });
          },
          select: () => reportCaret(),
        });
      } catch (cause) {
        if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
      }
    };

    void boot();
    const failTimer = window.setTimeout(() => {
      if (!disposed && !readyRef.current) {
        setError("编辑器未能完成渲染，已切换为纯文本模式");
      }
    }, 6000);

    const onPointer = () => reportCaret();
    const onKey = () => reportCaret();
    const onEnter = (event: KeyboardEvent) => {
      if (readOnlyRef.current) return;
      if (handleEnterAtDocumentEnd(event, mount)) reportCaret();
    };
    const onClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const anchor = target?.closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement) || !mount.contains(anchor)) return;
      const href = anchor.getAttribute("href") ?? "";
      if (!href || href.startsWith("#")) return;
      event.preventDefault();
      handleLink(href);
    };
    mount.addEventListener("keydown", onEnter, true);
    mount.addEventListener("keyup", onKey);
    mount.addEventListener("mouseup", onPointer);
    mount.addEventListener("click", onClick);

    const popovers = new MutationObserver((mutations) => {
      const rebuilt = mutations.some((mutation) => mutation.target instanceof Element
        && mutation.target.classList.contains("vditor-panel"));
      if (rebuilt) decoratePopovers(mount);
    });
    popovers.observe(mount, { childList: true, subtree: true });

    return () => {
      disposed = true;
      window.clearTimeout(failTimer);
      popovers.disconnect();
      mount.removeEventListener("keydown", onEnter, true);
      mount.removeEventListener("keyup", onKey);
      mount.removeEventListener("mouseup", onPointer);
      mount.removeEventListener("click", onClick);
      destroyMount(instance ?? instanceRef.current);
    };
  }, [pageId, rebuildKey]);

  useEffect(() => {
    const instance = instanceRef.current;
    if (!readyRef.current || !instance) return;
    if (markdownEquals(instance.getValue(), value)) return;
    applyingExternalRef.current = true;
    try {
      instance.setValue(value, true);
      valueRef.current = value;
      rebuildOnceRef.current = false;
    } catch {
      applyingExternalRef.current = false;
      if (!rebuildOnceRef.current) {
        rebuildOnceRef.current = true;
        setRebuildKey((current) => current + 1);
        return;
      }
    }
    const timer = window.setTimeout(() => {
      applyingExternalRef.current = false;
      const host = hostRef.current;
      if (host) ensureTrailingParagraph(host);
    }, 80);
    return () => window.clearTimeout(timer);
  }, [value]);

  useEffect(() => {
    const instance = instanceRef.current;
    if (!readyRef.current || !instance) return;
    if (readOnly) {
      valueRef.current = instance.getValue();
      onChangeRef.current(valueRef.current);
      instance.disabled();
      return;
    }
    instance.enable();
  }, [readOnly]);

  useEffect(() => {
    const instance = instanceRef.current;
    if (!readyRef.current || !instance) return;
    instance.setTheme(theme === "dark" ? "dark" : "classic");
  }, [theme]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    refreshHyperSpaceEmbeds(host, {
      getNodes: () => nodesRef.current,
      onNavigateNode: (nodeId) => onNavigateRef.current(nodeId),
    });
    annotateHeadingElements(host, valueRef.current);
    ensureTrailingParagraph(host);
  }, [nodes]);

  if (error) {
    return (
      <div className="vditor-fallback">
        <strong>编辑器初始化失败，已切换为纯文本模式</strong>
        <small>{error}</small>
        <textarea
          value={value}
          readOnly={readOnly}
          onChange={(event) => onChange(event.currentTarget.value)}
          onSelect={(event) => {
            const textarea = event.currentTarget;
            onCursorChange?.(cursorFromTextarea(textarea));
            const headings = parseMarkdownHeadings(textarea.value);
            const line = textarea.value.slice(0, textarea.selectionStart).split("\n").length;
            const heading = [...headings].reverse().find((item) => item.line <= line);
            onActiveHeadingChange?.(heading?.id ?? null);
          }}
        />
      </div>
    );
  }

  return (
    <div className="hyperspace-vditor">
      {!ready && (
        <div className="hyperspace-vditor__pending">
          {value.trim()
            ? <pre className="hyperspace-vditor__boot">{value}</pre>
            : <p className="hyperspace-vditor__placeholder">开始记录…</p>}
        </div>
      )}
      <div className={`hyperspace-vditor__host${ready ? " is-ready" : ""}`} ref={hostRef} />
    </div>
  );
}
