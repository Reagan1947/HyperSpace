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
  headingLabelFromElement,
  parseMarkdownHeadings,
} from "./markdownNavigation";
import type { ContentNode, MarkdownBookmark } from "./types";
import { installVditorContractIcon, withLucideToolbarIcons } from "./vditorToolbarIcons";

export interface HyperSpaceVditorProps {
  pageId: string;
  value: string;
  nodes: ContentNode[];
  bookmarks: MarkdownBookmark[];
  readOnly: boolean;
  theme?: "light" | "dark";
  onChange: (markdown: string) => void;
  onNavigateNode: (nodeId: string) => void;
  onToggleBookmark: (line: number, label: string) => void;
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

const LINE_NUMBER_SKIP = ".vditor-copy, .vditor-linenumber__rows";

function skipIrLineSubtree(element: Element, allowPreview: boolean, reject: Element[] = []) {
  if (reject.some((node) => node === element || node.contains(element))) return true;
  if (element.closest(LINE_NUMBER_SKIP)) return true;
  if (!allowPreview && element.closest(".vditor-ir__preview")) return true;
  return false;
}

function irLineFilter(allowPreview: boolean, reject: Element[] = []): NodeFilter {
  return {
    acceptNode(node) {
      if (node instanceof Element) {
        if (skipIrLineSubtree(node, allowPreview, reject)) return NodeFilter.FILTER_REJECT;
        if (node.tagName === "BR") return NodeFilter.FILTER_ACCEPT;
        return NodeFilter.FILTER_SKIP;
      }
      const parent = node.parentElement;
      if (!parent || skipIrLineSubtree(parent, allowPreview, reject)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  };
}

function rectAtText(node: Text, offset: number) {
  const length = node.nodeValue?.length ?? 0;
  if (!length) return null;
  const start = Math.min(offset, length - 1);
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, Math.min(start + 1, length));
  const rect = range.getBoundingClientRect();
  return rect.height < 1 && rect.width < 1 ? null : rect;
}

type LineBox = { top: number; height: number };

const FOLDED_SECTION_CLASS = "hyperspace-vditor__section-folded";
const COLLAPSED_HEADING_CLASS = "hyperspace-vditor__heading-collapsed";

function pushLineBox(lines: LineBox[], rect: { top: number; height: number; width?: number } | null, originTop: number) {
  if (!rect || (rect.height < 1 && (rect.width ?? 1) < 1)) return;
  const top = rect.top - originTop;
  const previous = lines.at(-1);
  if (previous && top < previous.top + previous.height * 0.5) return;
  lines.push({ top, height: Math.max(rect.height, 1) });
}

function cssContentFirstLine(element: HTMLElement) {
  const style = window.getComputedStyle(element);
  const box = element.getBoundingClientRect();
  const paddingTop = Number.parseFloat(style.paddingTop) || 0;
  const borderTop = Number.parseFloat(style.borderTopWidth) || 0;
  let lineHeight = Number.parseFloat(style.lineHeight);
  if (!Number.isFinite(lineHeight) || lineHeight <= 0) {
    const fontSize = Number.parseFloat(style.fontSize);
    lineHeight = Number.isFinite(fontSize) && fontSize > 0 ? fontSize * 1.2 : 28;
  }
  return {
    top: box.top + paddingTop + borderTop,
    height: lineHeight,
  };
}

function headingVisualLineCount(element: HTMLElement) {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || parent.closest(".vditor-ir__marker, wbr")) return NodeFilter.FILTER_REJECT;
      const value = (node.nodeValue ?? "").replaceAll(ZWSP, "");
      return value.length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const tops: number[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (!(node instanceof Text)) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) {
      if (rect.height < 1 || rect.width < 1) continue;
      if (!tops.some((top) => Math.abs(top - rect.top) < 1)) tops.push(rect.top);
    }
  }
  return Math.max(1, tops.length);
}

function lastContentLineBox(element: HTMLElement) {
  if (isIrHeading(element)) {
    const first = cssContentFirstLine(element);
    const count = headingVisualLineCount(element);
    return { top: first.top + (count - 1) * first.height, height: first.height };
  }
  const style = window.getComputedStyle(element);
  const box = element.getBoundingClientRect();
  const paddingBottom = Number.parseFloat(style.paddingBottom) || 0;
  const borderBottom = Number.parseFloat(style.borderBottomWidth) || 0;
  let lineHeight = Number.parseFloat(style.lineHeight);
  if (!Number.isFinite(lineHeight) || lineHeight <= 0) {
    const fontSize = Number.parseFloat(style.fontSize);
    lineHeight = Number.isFinite(fontSize) && fontSize > 0 ? fontSize * 1.2 : 24;
  }
  const bottom = box.bottom - paddingBottom - borderBottom;
  const height = Math.min(lineHeight, Math.max(box.height - paddingBottom, 8));
  return { top: bottom - height, height };
}

function collectHeadingLineBoxes(element: HTMLElement, originTop: number, lines: LineBox[]) {
  const first = cssContentFirstLine(element);
  const count = headingVisualLineCount(element);
  for (let index = 0; index < count; index += 1) {
    pushLineBox(lines, {
      top: first.top + index * first.height,
      height: first.height,
    }, originTop);
  }
}

function firstLineBox(element: HTMLElement, reject: Element[] = []) {
  const walker = document.createTreeWalker(
    element,
    NodeFilter.SHOW_TEXT,
    irLineFilter(false, reject),
  );
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (!(node instanceof Text)) continue;
    const rect = rectAtText(node, 0);
    if (rect) return { top: rect.top, height: rect.height };
  }
  const box = element.getBoundingClientRect();
  const lineHeight = Number.parseFloat(window.getComputedStyle(element).lineHeight);
  const height = Number.isFinite(lineHeight) && lineHeight > 0
    ? Math.min(lineHeight, Math.max(box.height, 1))
    : Math.max(box.height, 1);
  return { top: box.top, height };
}

function collectTextLineBoxes(
  element: HTMLElement,
  originTop: number,
  lines: LineBox[],
  allowPreview: boolean,
  reject: Element[] = [],
) {
  const before = lines.length;
  pushLineBox(lines, firstLineBox(element, reject), originTop);
  let pending = false;
  const walker = document.createTreeWalker(
    element,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    irLineFilter(allowPreview, reject),
  );
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node instanceof Element) {
      pending = true;
      continue;
    }
    if (!(node instanceof Text)) continue;
    const value = node.nodeValue ?? "";
    let start = 0;
    while (start <= value.length) {
      if (pending) {
        if (start < value.length && value[start] !== "\n") {
          pushLineBox(lines, rectAtText(node, start), originTop);
          pending = false;
        } else if (start < value.length) {
          pending = true;
          start += 1;
          continue;
        } else {
          break;
        }
      }
      const newline = value.indexOf("\n", start);
      if (newline === -1) break;
      pending = true;
      start = newline + 1;
    }
  }
  if (lines.length === before) pushLineBox(lines, element.getBoundingClientRect(), originTop);
}

function isIrNestedBlock(element: HTMLElement) {
  const type = element.getAttribute("data-type");
  return element.tagName === "UL"
    || element.tagName === "OL"
    || element.tagName === "BLOCKQUOTE"
    || element.tagName === "TABLE"
    || type === "code-block"
    || type === "yaml-front-matter"
    || type === "math-block"
    || type === "html-block"
    || type === "table";
}

function collectIrBlockLines(element: HTMLElement, originTop: number, lines: LineBox[]) {
  if (element.classList.contains(FOLDED_SECTION_CLASS)) return;
  if (isIrHeading(element)) {
    collectHeadingLineBoxes(element, originTop, lines);
    return;
  }
  const type = element.getAttribute("data-type");
  if (element.tagName === "UL" || element.tagName === "OL") {
    for (const item of element.children) {
      if (item instanceof HTMLElement && item.tagName === "LI") {
        collectIrBlockLines(item, originTop, lines);
      }
    }
    return;
  }
  if (element.tagName === "BLOCKQUOTE") {
    for (const child of element.children) {
      if (child instanceof HTMLElement) collectIrBlockLines(child, originTop, lines);
    }
    return;
  }
  if (element.tagName === "TABLE" || type === "table") {
    for (const row of element.querySelectorAll("tr")) {
      if (row instanceof HTMLElement) pushLineBox(lines, row.getBoundingClientRect(), originTop);
    }
    return;
  }

  const fenced = type === "code-block"
    || type === "yaml-front-matter"
    || type === "math-block"
    || type === "html-block";
  if (fenced) {
    const expanded = element.classList.contains("vditor-ir__node--expand");
    if (!expanded) {
      const embed = element.querySelector<HTMLElement>(".hs-embed-host");
      if (embed) {
        pushLineBox(lines, embed.getBoundingClientRect(), originTop);
        return;
      }
    }
    const target = expanded
      ? element.querySelector<HTMLElement>("pre.vditor-ir__marker--pre code")
        ?? element.querySelector<HTMLElement>("pre.vditor-ir__marker--pre")
        ?? element
      : element.querySelector<HTMLElement>(".vditor-ir__preview code")
        ?? element.querySelector<HTMLElement>(".vditor-ir__preview")
        ?? element;
    collectTextLineBoxes(target, originTop, lines, !expanded);
    return;
  }

  const nested = element.tagName === "LI"
    ? [...element.children].filter((child): child is HTMLElement => (
      child instanceof HTMLElement && isIrNestedBlock(child)
    ))
    : [];
  collectTextLineBoxes(element, originTop, lines, false, nested);
  for (const child of nested) collectIrBlockLines(child, originTop, lines);
}

function collectIrLineBoxes(surface: HTMLElement) {
  const originTop = surface.getBoundingClientRect().top;
  const lines: LineBox[] = [];
  for (const child of surface.children) {
    if (!(child instanceof HTMLElement) || child.classList.contains(FOLDED_SECTION_CLASS)) continue;
    collectIrBlockLines(child, originTop, lines);
  }
  if (!lines.length) {
    const style = window.getComputedStyle(surface);
    const paddingTop = Number.parseFloat(style.paddingTop);
    const lineHeight = Number.parseFloat(style.lineHeight);
    lines.push({
      top: Number.isFinite(paddingTop) ? paddingTop : 0,
      height: Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : 28,
    });
  }
  return lines;
}

function isIrHeading(element: Element) {
  return /^H[1-6]$/.test(element.tagName);
}

function headingLevelFromTag(element: HTMLElement) {
  const match = element.tagName.match(/^H([1-6])$/);
  return match ? Number(match[1]) : 0;
}

function headingSection(heading: HTMLElement) {
  const level = headingLevelFromTag(heading);
  const blocks: HTMLElement[] = [];
  let sibling = heading.nextElementSibling;
  while (sibling instanceof HTMLElement) {
    if (isIrHeading(sibling) && headingLevelFromTag(sibling) <= level) break;
    blocks.push(sibling);
    sibling = sibling.nextElementSibling;
  }
  return blocks;
}

function applyHeadingFolds(surface: HTMLElement, collapsed: Set<string>) {
  const liveIds = new Set<string>();
  const shouldFold = new Set<HTMLElement>();
  const shouldCollapse = new Set<HTMLElement>();
  for (const heading of surface.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")) {
    const id = heading.dataset.hsHeadingId;
    if (id) liveIds.add(id);
    if (!id || !collapsed.has(id)) continue;
    const section = headingSection(heading);
    if (!section.length) continue;
    shouldCollapse.add(heading);
    for (const block of section) shouldFold.add(block);
  }
  for (const id of [...collapsed]) {
    if (!liveIds.has(id)) collapsed.delete(id);
  }
  for (const node of surface.querySelectorAll(`.${FOLDED_SECTION_CLASS}`)) {
    if (node instanceof HTMLElement && !shouldFold.has(node)) node.classList.remove(FOLDED_SECTION_CLASS);
  }
  for (const node of surface.querySelectorAll(`.${COLLAPSED_HEADING_CLASS}`)) {
    if (node instanceof HTMLElement && !shouldCollapse.has(node)) node.classList.remove(COLLAPSED_HEADING_CLASS);
  }
  for (const node of shouldFold) {
    if (!node.classList.contains(FOLDED_SECTION_CLASS)) node.classList.add(FOLDED_SECTION_CLASS);
  }
  for (const node of shouldCollapse) {
    if (!node.classList.contains(COLLAPSED_HEADING_CLASS)) node.classList.add(COLLAPSED_HEADING_CLASS);
  }
}

function gutterLayer(gutter: HTMLDivElement, className: string) {
  for (const child of gutter.children) {
    if (child instanceof HTMLDivElement && child.className === className) return child;
  }
  const layer = document.createElement("div");
  layer.className = className;
  gutter.append(layer);
  return layer;
}

type StructureRange = {
  id: string;
  level: number;
  text: string;
  foldable: boolean;
  collapsed: boolean;
  hasEnd: boolean;
  top: number;
  height: number;
  startHeight: number;
  endHeight: number;
};

function visibleStructureHeadings(surface: HTMLElement) {
  return [...surface.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")]
    .filter((heading) => (
      !heading.classList.contains(FOLDED_SECTION_CLASS)
      && !heading.closest(`.${FOLDED_SECTION_CLASS}`)
    ));
}

function collectStructureRanges(surface: HTMLElement, collapsed: Set<string>): StructureRange[] {
  const originTop = surface.getBoundingClientRect().top;
  return visibleStructureHeadings(surface).flatMap((heading) => {
    const id = heading.dataset.hsHeadingId;
    if (!id) return [];
    const start = cssContentFirstLine(heading);
    const section = headingSection(heading);
    const foldable = section.length > 0;
    const isCollapsed = collapsed.has(id);
    const end = !isCollapsed && foldable
      ? lastContentLineBox(section.at(-1) ?? heading)
      : start;
    const top = start.top - originTop;
    const bottom = end.top + end.height - originTop;
    const hasEnd = !isCollapsed && foldable && bottom - top > 18;
    return [{
      id,
      level: headingLevelFromTag(heading),
      text: headingLabelFromElement(heading),
      foldable,
      collapsed: isCollapsed,
      hasEnd,
      top,
      height: Math.max(start.height, hasEnd ? bottom - top : start.height),
      startHeight: start.height,
      endHeight: end.height,
    } satisfies StructureRange];
  });
}

function structureAnchorButton(kind: "start" | "end") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `hyperspace-vditor__structure-anchor is-${kind}`;
  return button;
}

function syncStructureAnchor(
  button: HTMLButtonElement,
  range: StructureRange,
  kind: "start" | "end",
) {
  button.dataset.headingId = range.id;
  button.dataset.level = String(range.level);
  button.disabled = !range.foldable;
  const label = kind === "end"
    ? `「${range.text}」结束`
    : !range.foldable
      ? range.text
      : range.collapsed ? `展开「${range.text}」` : `收拢「${range.text}」`;
  button.title = label;
  button.setAttribute("aria-label", label);
  if (kind === "start") {
    button.style.top = `${Math.max(0, (range.startHeight - 20) / 2)}px`;
    button.style.bottom = "auto";
  } else {
    button.style.top = "auto";
    button.style.bottom = `${Math.max(0, (range.endHeight - 20) / 2)}px`;
  }
}

function syncStructureRange(element: HTMLDivElement, range: StructureRange) {
  element.dataset.headingId = range.id;
  element.dataset.level = String(range.level);
  element.dataset.foldable = range.foldable ? "1" : "0";
  element.classList.toggle("is-collapsed", range.collapsed);
  element.classList.toggle("has-end", range.hasEnd);
  element.style.top = `${range.top}px`;
  element.style.height = `${range.height}px`;
  element.style.zIndex = String(range.level);
  element.setAttribute("aria-expanded", range.collapsed ? "false" : "true");

  let start = element.querySelector<HTMLButtonElement>(":scope > .is-start");
  if (!start) {
    start = structureAnchorButton("start");
    element.prepend(start);
  }
  syncStructureAnchor(start, range, "start");

  let end = element.querySelector<HTMLButtonElement>(":scope > .is-end");
  if (range.hasEnd) {
    if (!end) {
      end = structureAnchorButton("end");
      element.append(end);
    }
    syncStructureAnchor(end, range, "end");
  } else {
    end?.remove();
  }
}

function renderStructureAnchors(layer: HTMLDivElement, surface: HTMLElement, collapsed: Set<string>) {
  const ranges = collectStructureRanges(surface, collapsed);
  if (layer.childElementCount === ranges.length) {
    const same = ranges.every((range, index) => {
      const child = layer.children[index];
      return child instanceof HTMLElement && child.dataset.headingId === range.id;
    });
    if (same) {
      for (let index = 0; index < ranges.length; index += 1) {
        const child = layer.children[index];
        if (child instanceof HTMLDivElement) syncStructureRange(child, ranges[index]);
      }
      return;
    }
  }

  layer.replaceChildren(...ranges.map((range) => {
    const element = document.createElement("div");
    element.className = "hyperspace-vditor__structure-range";
    syncStructureRange(element, range);
    return element;
  }));
}

function isLineNumberNode(node: Node | null) {
  const element = node instanceof Element ? node : node?.parentElement;
  return Boolean(element?.closest(".hyperspace-vditor__line-numbers, .hyperspace-vditor__structure"));
}

function ensureLineGutter(anchor: Element, className: string) {
  const next = anchor.nextElementSibling;
  if (next instanceof HTMLDivElement && next.className === className) return next;
  if (next instanceof HTMLElement && next.classList.contains("hyperspace-vditor__line-numbers")) next.remove();
  const gutter = document.createElement("div");
  gutter.className = className;
  gutter.setAttribute("aria-hidden", "true");
  anchor.insertAdjacentElement("afterend", gutter);
  return gutter;
}

function installSourceLineNumbers(
  root: HTMLElement,
  getMarkdown: () => string,
  getBookmarks: () => MarkdownBookmark[],
  onToggleBookmark: (line: number, label: string) => void,
) {
  let svGutter: HTMLDivElement | null = null;
  let irGutter: HTMLDivElement | null = null;
  let frame = 0;
  let contextMenu: HTMLDivElement | null = null;
  const collapsedHeadings = new Set<string>();

  const syncLineNumber = (span: HTMLElement, line: number) => {
    span.textContent = String(line);
    span.dataset.line = String(line);
    span.classList.toggle("has-bookmark", getBookmarks().some((bookmark) => bookmark.line === line));
  };

  const closeContextMenu = () => {
    contextMenu?.remove();
    contextMenu = null;
  };

  const onLineContextMenu = (event: MouseEvent) => {
    const lineElement = event.target instanceof Element
      ? event.target.closest<HTMLElement>(".hyperspace-vditor__line-numbers-list > span")
      : null;
    const line = Number(lineElement?.dataset.line ?? 0);
    if (!line) return;
    event.preventDefault();
    event.stopPropagation();
    closeContextMenu();
    const existing = getBookmarks().some((bookmark) => bookmark.line === line);
    const menu = document.createElement("div");
    menu.className = "markdown-context-menu";
    menu.setAttribute("role", "menu");
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "menuitem");
    button.textContent = existing ? "移除 Bookmark" : "添加 Bookmark";
    button.addEventListener("click", () => {
      const label = getMarkdown().split("\n")[line - 1]?.trim() || `第 ${line} 行`;
      onToggleBookmark(line, label);
      lineElement?.classList.toggle("has-bookmark", !existing);
      closeContextMenu();
    });
    menu.append(button);
    document.body.append(menu);
    const bounds = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - bounds.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - bounds.height - 8))}px`;
    contextMenu = menu;
  };

  const onDismissContextMenu = (event: Event) => {
    if (contextMenu?.contains(event.target as Node)) return;
    closeContextMenu();
  };

  document.addEventListener("pointerdown", onDismissContextMenu);
  window.addEventListener("blur", closeContextMenu);

  const renderSv = () => {
    const textarea = root.querySelector<HTMLTextAreaElement>("textarea.vditor-sv");
    if (!textarea) {
      svGutter?.remove();
      svGutter = null;
      return;
    }

    svGutter = ensureLineGutter(textarea, "hyperspace-vditor__line-numbers");
    const hidden = window.getComputedStyle(textarea).display === "none";
    svGutter.hidden = hidden;
    if (hidden) return;

    const lineCount = textarea.value.split("\n").length;
    if (Number(svGutter.dataset.lineCount ?? 0) !== lineCount) {
      svGutter.textContent = Array.from({ length: lineCount }, (_, index) => String(index + 1)).join("\n");
      svGutter.dataset.lineCount = String(lineCount);
    }

    const textareaStyle = window.getComputedStyle(textarea);
    const parentRect = textarea.parentElement?.getBoundingClientRect();
    const textareaRect = textarea.getBoundingClientRect();
    if (!parentRect) return;
    svGutter.style.left = `${textareaRect.left - parentRect.left}px`;
    svGutter.style.top = `${textareaRect.top - parentRect.top + Number.parseFloat(textareaStyle.paddingTop)}px`;
    svGutter.style.width = textareaStyle.paddingLeft;
    svGutter.style.fontFamily = textareaStyle.fontFamily;
    svGutter.style.fontSize = textareaStyle.fontSize;
    svGutter.style.lineHeight = textareaStyle.lineHeight;
  };

  const onStructureClick = (event: Event) => {
    const range = event.target instanceof Element
      ? event.target.closest<HTMLElement>(".hyperspace-vditor__structure-range")
      : null;
    if (!range || range.dataset.foldable !== "1") return;
    event.preventDefault();
    event.stopPropagation();
    const id = range.dataset.headingId;
    if (!id) return;
    if (collapsedHeadings.has(id)) collapsedHeadings.delete(id);
    else collapsedHeadings.add(id);
    schedule();
  };

  const onStructureMouseDown = (event: MouseEvent) => {
    if (event.target instanceof Element && event.target.closest(".hyperspace-vditor__structure-range")) {
      event.preventDefault();
    }
  };

  const renderIr = () => {
    const surface = root.querySelector<HTMLElement>(".vditor-ir pre.vditor-reset");
    const pane = surface?.parentElement;
    if (!surface || !pane || window.getComputedStyle(pane).display === "none") {
      irGutter?.remove();
      irGutter = null;
      return;
    }

    annotateHeadingElements(root, getMarkdown());
    applyHeadingFolds(surface, collapsedHeadings);

    irGutter = ensureLineGutter(surface, "hyperspace-vditor__line-numbers hyperspace-vditor__line-numbers--ir");
    irGutter.removeAttribute("aria-hidden");
    const paneRect = pane.getBoundingClientRect();
    const surfaceRect = surface.getBoundingClientRect();
    irGutter.hidden = false;
    irGutter.style.left = "0";
    irGutter.style.removeProperty("width");
    irGutter.style.top = `${surfaceRect.top - paneRect.top}px`;
    irGutter.style.height = `${surface.offsetHeight}px`;
    if (!irGutter.dataset.structureBound) {
      irGutter.dataset.structureBound = "1";
      irGutter.addEventListener("click", onStructureClick);
      irGutter.addEventListener("mousedown", onStructureMouseDown);
      irGutter.addEventListener("contextmenu", onLineContextMenu);
    }

    const numberLayer = gutterLayer(irGutter, "hyperspace-vditor__line-numbers-list");
    const structureLayer = gutterLayer(irGutter, "hyperspace-vditor__structure");
    const lines = collectIrLineBoxes(surface);
    if (Number(irGutter.dataset.lineCount ?? 0) !== lines.length || numberLayer.childElementCount !== lines.length) {
      numberLayer.replaceChildren(...lines.map((line, index) => {
        const span = document.createElement("span");
        syncLineNumber(span, index + 1);
        span.style.top = `${line.top}px`;
        span.style.height = `${line.height}px`;
        return span;
      }));
      irGutter.dataset.lineCount = String(lines.length);
    } else {
      for (let index = 0; index < lines.length; index += 1) {
        const span = numberLayer.children[index];
        if (!(span instanceof HTMLElement)) continue;
        syncLineNumber(span, index + 1);
        span.style.top = `${lines[index].top}px`;
        span.style.height = `${lines[index].height}px`;
      }
    }

    renderStructureAnchors(structureLayer, surface, collapsedHeadings);
  };

  const render = () => {
    renderSv();
    renderIr();
  };

  const schedule = () => {
    if (frame) return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      render();
    });
  };

  root.addEventListener("input", schedule);
  const mutations = new MutationObserver((records) => {
    if (records.some((record) => !isLineNumberNode(record.target))) schedule();
  });
  mutations.observe(root, {
    attributes: true,
    attributeFilter: ["class", "style"],
    childList: true,
    subtree: true,
  });
  const resize = new ResizeObserver(schedule);
  resize.observe(root);
  schedule();

  return () => {
    window.cancelAnimationFrame(frame);
    root.removeEventListener("input", schedule);
    mutations.disconnect();
    resize.disconnect();
    irGutter?.removeEventListener("click", onStructureClick);
    irGutter?.removeEventListener("mousedown", onStructureMouseDown);
    irGutter?.removeEventListener("contextmenu", onLineContextMenu);
    document.removeEventListener("pointerdown", onDismissContextMenu);
    window.removeEventListener("blur", closeContextMenu);
    closeContextMenu();
    svGutter?.remove();
    irGutter?.remove();
  };
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
  bookmarks,
  readOnly,
  theme = "light",
  onChange,
  onNavigateNode,
  onToggleBookmark,
  onActiveHeadingChange,
  onCursorChange,
}: HyperSpaceVditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<Vditor | null>(null);
  const readyRef = useRef(false);
  const valueRef = useRef(value);
  const nodesRef = useRef(nodes);
  const bookmarksRef = useRef(bookmarks);
  const readOnlyRef = useRef(readOnly);
  const themeRef = useRef(theme);
  const onChangeRef = useRef(onChange);
  const onNavigateRef = useRef(onNavigateNode);
  const onToggleBookmarkRef = useRef(onToggleBookmark);
  const onHeadingRef = useRef(onActiveHeadingChange);
  const onCursorRef = useRef(onCursorChange);
  const applyingExternalRef = useRef(false);
  const rebuildOnceRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [rebuildKey, setRebuildKey] = useState(0);
  const [ready, setReady] = useState(false);

  valueRef.current = value;
  nodesRef.current = nodes;
  bookmarksRef.current = bookmarks;
  readOnlyRef.current = readOnly;
  themeRef.current = theme;
  onChangeRef.current = onChange;
  onNavigateRef.current = onNavigateNode;
  onToggleBookmarkRef.current = onToggleBookmark;
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
    const removeSourceLineNumbers = installSourceLineNumbers(
      mount,
      () => valueRef.current,
      () => bookmarksRef.current,
      (line, label) => onToggleBookmarkRef.current(line, label),
    );

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
      removeSourceLineNumbers();
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
