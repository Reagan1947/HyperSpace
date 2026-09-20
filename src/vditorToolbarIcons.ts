/** Lucide 0.468.0 outlines, inlined so Vditor can paint them as toolbar SVG. */

const lucideSvg = (inner: string) =>
  `<svg class="hs-toolbar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

const lucideInner = {
  heading: '<path d="M6 12h12"/><path d="M6 20V4"/><path d="M18 20V4"/>',
  bold: '<path d="M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8"/>',
  italic: '<line x1="19" x2="10" y1="4" y2="4"/><line x1="14" x2="5" y1="20" y2="20"/><line x1="15" x2="9" y1="4" y2="20"/>',
  strikethrough: '<path d="M16 4H9a3 3 0 0 0-2.83 4"/><path d="M14 12a4 4 0 0 1 0 8H6"/><line x1="4" x2="20" y1="12" y2="12"/>',
  list: '<path d="M3 12h.01"/><path d="M3 18h.01"/><path d="M3 6h.01"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M8 6h13"/>',
  listOrdered: '<path d="M10 12h11"/><path d="M10 18h11"/><path d="M10 6h11"/><path d="M4 10h2"/><path d="M4 6h1v4"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/>',
  listTodo: '<rect x="3" y="5" width="6" height="6" rx="1"/><path d="m3 17 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>',
  quote: '<path d="M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/><path d="M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/>',
  code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  codeXml: '<path d="m18 16 4-4-4-4"/><path d="m6 8-4 4 4 4"/><path d="m14.5 4-5 16"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  table: '<path d="M12 3v18"/><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  undo2: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"/>',
  redo2: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5A5.5 5.5 0 0 0 9.5 20H13"/>',
  squarePen: '<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"/>',
  columns2: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M12 3v18"/>',
  eye: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
  listTree: '<path d="M21 12h-8"/><path d="M21 6H8"/><path d="M21 18h-8"/><path d="M3 6v4c0 1.1.9 2 2 2h3"/><path d="M3 10v6c0 1.1.9 2 2 2h3"/>',
  maximize2: '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" x2="14" y1="3" y2="10"/><line x1="3" x2="10" y1="21" y2="14"/>',
  minimize2: '<polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" x2="21" y1="10" y2="3"/><line x1="3" x2="10" y1="21" y2="14"/>',
} as const;

/** Vditor toolbar `name` → Lucide standard icon. */
export const vditorToolbarIcons: Record<string, string> = {
  headings: lucideSvg(lucideInner.heading),
  bold: lucideSvg(lucideInner.bold),
  italic: lucideSvg(lucideInner.italic),
  strike: lucideSvg(lucideInner.strikethrough),
  list: lucideSvg(lucideInner.list),
  "ordered-list": lucideSvg(lucideInner.listOrdered),
  check: lucideSvg(lucideInner.listTodo),
  quote: lucideSvg(lucideInner.quote),
  code: lucideSvg(lucideInner.code),
  "inline-code": lucideSvg(lucideInner.codeXml),
  link: lucideSvg(lucideInner.link),
  table: lucideSvg(lucideInner.table),
  "hyperspace-file": lucideSvg(lucideInner.file),
  "hyperspace-folder": lucideSvg(lucideInner.folder),
  undo: lucideSvg(lucideInner.undo2),
  redo: lucideSvg(lucideInner.redo2),
  "edit-mode": lucideSvg(lucideInner.squarePen),
  both: lucideSvg(lucideInner.columns2),
  preview: lucideSvg(lucideInner.eye),
  outline: lucideSvg(lucideInner.listTree),
  fullscreen: lucideSvg(lucideInner.maximize2),
};

type ToolbarEntry = string | {
  name: string;
  icon?: string;
  tip?: string;
  click?: (event: Event) => void;
};

export function withLucideToolbarIcons(items: ToolbarEntry[]): ToolbarEntry[] {
  return items.map((item) => {
    if (typeof item === "string") {
      const icon = vditorToolbarIcons[item];
      return icon ? { name: item, icon } : item;
    }
    const icon = item.icon ?? vditorToolbarIcons[item.name];
    return icon ? { ...item, icon } : item;
  });
}

/** Vditor swaps fullscreen to `#vditor-icon-contract`; retarget that sprite to Lucide Minimize2. */
export function installVditorContractIcon() {
  const symbol = document.getElementById("vditor-icon-contract");
  if (!(symbol instanceof SVGSymbolElement) && !(symbol instanceof SVGElement)) return;
  symbol.setAttribute("viewBox", "0 0 24 24");
  symbol.setAttribute("fill", "none");
  symbol.setAttribute("stroke", "currentColor");
  symbol.setAttribute("stroke-width", "2");
  symbol.setAttribute("stroke-linecap", "round");
  symbol.setAttribute("stroke-linejoin", "round");
  symbol.innerHTML = lucideInner.minimize2;
}
