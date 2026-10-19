/** Primer Octicons 16px drawings. Vditor paints toolbar icons from SVG markup. */
import boldIcon from "@primer/octicons/build/svg/bold-16.svg?raw";
import codeIcon from "@primer/octicons/build/svg/code-16.svg?raw";
import codeSquareIcon from "@primer/octicons/build/svg/code-square-16.svg?raw";
import columnsIcon from "@primer/octicons/build/svg/columns-16.svg?raw";
import fileIcon from "@primer/octicons/build/svg/file-16.svg?raw";
import fileDirectoryIcon from "@primer/octicons/build/svg/file-directory-16.svg?raw";
import headingIcon from "@primer/octicons/build/svg/heading-16.svg?raw";
import italicIcon from "@primer/octicons/build/svg/italic-16.svg?raw";
import linkIcon from "@primer/octicons/build/svg/link-16.svg?raw";
import listOrderedIcon from "@primer/octicons/build/svg/list-ordered-16.svg?raw";
import listUnorderedIcon from "@primer/octicons/build/svg/list-unordered-16.svg?raw";
import pencilIcon from "@primer/octicons/build/svg/pencil-16.svg?raw";
import quoteIcon from "@primer/octicons/build/svg/quote-16.svg?raw";
import redoIcon from "@primer/octicons/build/svg/redo-16.svg?raw";
import strikethroughIcon from "@primer/octicons/build/svg/strikethrough-16.svg?raw";
import tableIcon from "@primer/octicons/build/svg/table-16.svg?raw";
import tasklistIcon from "@primer/octicons/build/svg/tasklist-16.svg?raw";
import undoIcon from "@primer/octicons/build/svg/undo-16.svg?raw";

const octicon = (svg: string) =>
  svg.replace("<svg ", '<svg class="hs-toolbar-icon" aria-hidden="true" focusable="false" fill="currentColor" ');

/** Vditor toolbar `name` → Octicon. */
export const vditorToolbarIcons: Record<string, string> = {
  headings: octicon(headingIcon),
  bold: octicon(boldIcon),
  italic: octicon(italicIcon),
  strike: octicon(strikethroughIcon),
  list: octicon(listUnorderedIcon),
  "ordered-list": octicon(listOrderedIcon),
  check: octicon(tasklistIcon),
  quote: octicon(quoteIcon),
  code: octicon(codeSquareIcon),
  "inline-code": octicon(codeIcon),
  link: octicon(linkIcon),
  table: octicon(tableIcon),
  "hyperspace-file": octicon(fileIcon),
  "hyperspace-folder": octicon(fileDirectoryIcon),
  undo: octicon(undoIcon),
  redo: octicon(redoIcon),
  "edit-mode": octicon(pencilIcon),
  both: octicon(columnsIcon),
};

type ToolbarEntry = string | {
  name: string;
  icon?: string;
  tip?: string;
  /** Vditor chord, e.g. "⇧⌘T". ⌘ is Ctrl on Windows and Linux. */
  hotkey?: string;
  click?: (event: Event) => void;
};

export function withOcticonsToolbarIcons(items: ToolbarEntry[]): ToolbarEntry[] {
  return items.map((item) => {
    if (typeof item === "string") {
      const icon = vditorToolbarIcons[item];
      return icon ? { name: item, icon } : item;
    }
    const icon = item.icon ?? vditorToolbarIcons[item.name];
    return icon ? { ...item, icon } : item;
  });
}
