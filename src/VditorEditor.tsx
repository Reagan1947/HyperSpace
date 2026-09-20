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

// Lucide File/Folder outlines, so the custom buttons match the toolbar's icon set.
const fileIcon = '<svg class="hs-toolbar-icon" viewBox="0 0 24 24"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>';
const folderIcon = '<svg class="hs-toolbar-icon" viewBox="0 0 24 24"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>';

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

function decorateToolbar(root: HTMLElement) {
  for (const button of root.querySelectorAll<HTMLElement>(".vditor-toolbar button[aria-label]")) {
    const label = button.getAttribute("aria-label") ?? "";
    const match = label.match(SHORTCUT_SUFFIX);
    button.title = match ? `${match[1]} ${match[2]}` : label;
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
          toolbar: [
            "headings", "bold", "italic", "strike", "|",
            "list", "ordered-list", "check", "quote", "|",
            "code", "inline-code", "link", "table",
            {
              name: "hyperspace-file",
              icon: fileIcon,
              tip: "嵌入文件",
              click: () => {
                if (instanceRef.current) insertHyperSpaceEmbed(instanceRef.current, "file", nodesRef.current);
              },
            },
            {
              name: "hyperspace-folder",
              icon: folderIcon,
              tip: "嵌入文件夹",
              click: () => {
                if (instanceRef.current) insertHyperSpaceEmbed(instanceRef.current, "folder", nodesRef.current);
              },
            },
            "|", "undo", "redo", "edit-mode", "both", "preview", "outline", "fullscreen",
          ],
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
            decorateToolbar(mount);
            readyRef.current = true;
            setReady(true);
            setError(null);
            window.setTimeout(() => { applyingExternalRef.current = false; }, 80);
          },
          input: (markdown) => {
            if (disposed || !readyRef.current || applyingExternalRef.current) return;
            if (markdown === valueRef.current) {
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
    const onClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const anchor = target?.closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement) || !mount.contains(anchor)) return;
      const href = anchor.getAttribute("href") ?? "";
      if (!href || href.startsWith("#")) return;
      event.preventDefault();
      handleLink(href);
    };
    mount.addEventListener("keyup", onKey);
    mount.addEventListener("mouseup", onPointer);
    mount.addEventListener("click", onClick);

    return () => {
      disposed = true;
      window.clearTimeout(failTimer);
      mount.removeEventListener("keyup", onKey);
      mount.removeEventListener("mouseup", onPointer);
      mount.removeEventListener("click", onClick);
      destroyMount(instance ?? instanceRef.current);
    };
  }, [pageId, rebuildKey]);

  useEffect(() => {
    const instance = instanceRef.current;
    if (!readyRef.current || !instance) return;
    if (instance.getValue() === value) return;
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
    queueMicrotask(() => { applyingExternalRef.current = false; });
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
