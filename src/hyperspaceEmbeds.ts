import type Vditor from "vditor";
import type { ContentNode } from "./types";

export interface HyperSpaceEmbed {
  version: 1;
  kind: "file" | "folder";
  targetNodeId: string;
  blockId: string;
}

export interface HyperSpaceEmbedContext {
  getNodes: () => ContentNode[];
  onNavigateNode: (nodeId: string) => void;
}

const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function parseHyperSpaceEmbed(source: string): HyperSpaceEmbed | null {
  try {
    const value = JSON.parse(source.trim()) as Partial<HyperSpaceEmbed>;
    if (
      value.version !== 1 ||
      (value.kind !== "file" && value.kind !== "folder") ||
      typeof value.targetNodeId !== "string" ||
      typeof value.blockId !== "string" ||
      !NODE_ID_PATTERN.test(value.targetNodeId) ||
      !NODE_ID_PATTERN.test(value.blockId)
    ) return null;
    return value as HyperSpaceEmbed;
  } catch {
    return null;
  }
}

export function serializeHyperSpaceEmbed(embed: HyperSpaceEmbed) {
  const payload = JSON.stringify({
    version: 1,
    kind: embed.kind,
    targetNodeId: embed.targetNodeId,
    blockId: embed.blockId,
  });
  return `\n\n\`\`\`hyperspace\n${payload}\n\`\`\`\n\n`;
}

function icon(label: string, className: string) {
  const element = document.createElement("span");
  element.className = className;
  element.textContent = label;
  return element;
}

function secondaryText(node: ContentNode) {
  return [node.fileType, node.size, node.updatedAt].filter(Boolean).join(" · ");
}

function renderMissingCard(source: string) {
  const card = document.createElement("div");
  card.className = "hs-embed-card hs-embed-card--error";
  const title = document.createElement("strong");
  title.textContent = "无法渲染 HyperSpace 卡片";
  const detail = document.createElement("small");
  detail.textContent = source.trim() ? "引用无效或目标已删除" : "卡片源码为空";
  card.append(title, detail);
  if (source.trim()) {
    const sourceBlock = document.createElement("details");
    sourceBlock.className = "hs-embed-card__source";
    const summary = document.createElement("summary");
    summary.textContent = "编辑源码";
    const pre = document.createElement("pre");
    pre.textContent = source.trim();
    sourceBlock.append(summary, pre);
    card.append(sourceBlock);
  }
  return card;
}

function renderCard(embed: HyperSpaceEmbed, nodes: ContentNode[], onNavigateNode: (id: string) => void) {
  const target = nodes.find((node) => node.id === embed.targetNodeId && node.kind === embed.kind);
  if (!target) return renderMissingCard(JSON.stringify(embed));

  const card = document.createElement("button");
  card.type = "button";
  card.className = `hs-embed-card hs-embed-card--${embed.kind}`;
  card.dataset.blockId = embed.blockId;
  card.dataset.targetNodeId = target.id;
  card.append(icon(embed.kind === "folder" ? "DIR" : target.fileType ?? "FILE", "hs-embed-card__icon"));

  const copy = document.createElement("span");
  copy.className = "hs-embed-card__copy";
  const title = document.createElement("strong");
  title.textContent = target.title;
  const detail = document.createElement("small");
  if (embed.kind === "folder") {
    const count = nodes.filter((node) => node.parentId === target.id).length;
    detail.textContent = `${count} 个项目 · ${target.updatedAt}`;
  } else {
    detail.textContent = secondaryText(target);
  }
  copy.append(title, detail);
  const action = document.createElement("span");
  action.className = "hs-embed-card__action";
  action.textContent = embed.kind === "folder" ? "打开文件夹" : "打开文件";
  card.append(copy, action);
  card.addEventListener("click", () => onNavigateNode(target.id));
  return card;
}

function isSourceMarker(element: HTMLElement) {
  return Boolean(
    element.closest(".vditor-ir__marker, .vditor-ir__marker--pre, .vditor-sv, .vditor-sv__editor"),
  );
}

function previewHosts(root: HTMLElement) {
  const hosts: HTMLElement[] = [];
  if (root.matches("pre, .vditor-ir__preview, .vditor-wysiwyg__preview")) hosts.push(root);
  root.querySelectorAll<HTMLElement>("pre > code.language-hyperspace, code.language-hyperspace").forEach((code) => {
    const host = code.parentElement;
    if (host) hosts.push(host);
  });
  return hosts.filter((host, index) => hosts.indexOf(host) === index && !isSourceMarker(host));
}

function sourceFromHost(host: HTMLElement) {
  return host.dataset.hsSource
    ?? host.querySelector("code.language-hyperspace")?.textContent
    ?? "";
}

function paintHost(host: HTMLElement, context: HyperSpaceEmbedContext) {
  const source = sourceFromHost(host);
  const embed = parseHyperSpaceEmbed(source);
  const keep = document.createElement("code");
  keep.className = "language-hyperspace";
  keep.hidden = true;
  keep.textContent = source;
  host.dataset.hsRendered = "true";
  host.dataset.hsSource = source;
  host.classList.add("hs-embed-host");
  host.replaceChildren(
    embed ? renderCard(embed, context.getNodes(), context.onNavigateNode) : renderMissingCard(source),
    keep,
  );
}

export function renderHyperSpaceEmbeds(root: HTMLElement, context: HyperSpaceEmbedContext) {
  for (const host of previewHosts(root)) {
    if (host.dataset.hsRendered === "true") continue;
    paintHost(host, context);
  }
}

export function refreshHyperSpaceEmbeds(root: HTMLElement, context: HyperSpaceEmbedContext) {
  root.querySelectorAll<HTMLElement>(".hs-embed-host").forEach((host) => {
    if (isSourceMarker(host)) return;
    paintHost(host, context);
  });
  renderHyperSpaceEmbeds(root, context);
}

export function createHyperSpaceRenderer(context: HyperSpaceEmbedContext) {
  return {
    language: "hyperspace",
    render: (element: HTMLElement) => renderHyperSpaceEmbeds(element, context),
  };
}

function chooseNode(kind: "file" | "folder", nodes: ContentNode[]) {
  const candidates = nodes.filter((node) => node.kind === kind);
  if (!candidates.length) {
    window.alert(kind === "file" ? "当前工作空间没有可嵌入的文件" : "当前工作空间没有可嵌入的文件夹");
    return null;
  }
  const choices = candidates.map((node, index) => `${index + 1}. ${node.title}`).join("\n");
  const answer = window.prompt(`选择要嵌入的${kind === "file" ? "文件" : "文件夹"}：\n${choices}`, "1");
  const index = Number(answer) - 1;
  return Number.isInteger(index) && candidates[index] ? candidates[index] : null;
}

export function insertHyperSpaceEmbed(vditor: Vditor, kind: "file" | "folder", nodes: ContentNode[]) {
  const target = chooseNode(kind, nodes);
  if (!target) return;
  const blockId = `hs-${crypto.randomUUID()}`;
  vditor.insertValue(serializeHyperSpaceEmbed({ version: 1, kind, targetNodeId: target.id, blockId }));
}
