export interface MarkdownHeading {
  id: string;
  level: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;
  line: number;
  parentId: string | null;
}

function plainHeadingText(source: string) {
  return source
    .replace(/\s+#+\s*$/, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .replace(/<[^>]+>/g, "")
    .trim();
}

function slugify(value: string) {
  const slug = value
    .toLocaleLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, "")
    .trim()
    .replace(/[\s-]+/g, "-");
  return slug || "heading";
}

export function parseMarkdownHeadings(markdown: string): MarkdownHeading[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const headings: MarkdownHeading[] = [];
  const stack: MarkdownHeading[] = [];
  const slugCounts = new Map<string, number>();
  let fence: { marker: "`" | "~"; length: number } | null = null;

  const pushHeading = (level: MarkdownHeading["level"], raw: string, line: number) => {
    const text = plainHeadingText(raw);
    if (!text) return;
    const base = slugify(text);
    const count = slugCounts.get(base) ?? 0;
    slugCounts.set(base, count + 1);
    const id = count === 0 ? base : `${base}-${count + 1}`;
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    const heading: MarkdownHeading = {
      id,
      level,
      text,
      line,
      parentId: stack.at(-1)?.id ?? null,
    };
    headings.push(heading);
    stack.push(heading);
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0] as "`" | "~";
      if (!fence) fence = { marker, length: fenceMatch[1].length };
      else if (fence.marker === marker && fenceMatch[1].length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;

    const atx = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*$/);
    if (atx) {
      pushHeading(atx[1].length as MarkdownHeading["level"], atx[2], index + 1);
      continue;
    }

    if (index + 1 < lines.length && line.trim()) {
      const setext = lines[index + 1].match(/^\s{0,3}(=+|-+)\s*$/);
      if (setext) {
        pushHeading(setext[1][0] === "=" ? 1 : 2, line, index + 1);
        index += 1;
      }
    }
  }

  return headings;
}

export function headingPath(headings: MarkdownHeading[], headingId: string | null) {
  if (!headingId) return [];
  const byId = new Map(headings.map((heading) => [heading.id, heading]));
  const result: MarkdownHeading[] = [];
  let current = byId.get(headingId);
  while (current) {
    result.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return result;
}

export function headingSiblings(headings: MarkdownHeading[], headingId: string) {
  const target = headings.find((heading) => heading.id === headingId);
  if (!target) return [];
  return headings.filter((heading) =>
    heading.level === target.level && heading.parentId === target.parentId
  );
}

export function headingLabelFromElement(element: HTMLElement) {
  return (element.textContent ?? "")
    .replace(/^H[1-6]/, "")
    .replace(/^#{1,6}\s*/, "")
    .trim();
}

export function annotateHeadingElements(root: HTMLElement, markdown: string) {
  const headings = parseMarkdownHeadings(markdown);
  const elements = Array.from(root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6"))
    .filter((element) => !element.closest(".vditor-sv, .vditor-outline, .vditor-toolbar, .vditor-preview__action"));
  for (let index = 0; index < Math.min(headings.length, elements.length); index += 1) {
    elements[index].dataset.hsHeadingId = headings[index].id;
  }
}
