import { access, cp, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const source = resolve("node_modules/vditor/dist");
const packageRoot = resolve("public/vendor/vditor");
const destination = resolve(packageRoot, "dist");

// highlightRender() links this stylesheet on every render pass with no way to
// opt out, and falls back to "github" for any theme name it does not know.
// Serving it empty is how the app keeps syntax colours in styles.css.
const hljsThemeDir = "js/highlight.js/styles";
const hljsThemeStub = `${hljsThemeDir}/github.min.css`;

const required = [
  "index.css",
  "js/lute/lute.min.js",
  "js/i18n/zh_CN.js",
  "js/icons/ant.js",
  "js/highlight.js/highlight.min.js",
  "js/katex/katex.min.js",
  "js/katex/fonts/KaTeX_Main-Regular.woff2",
  "js/mermaid/mermaid.min.js",
  hljsThemeStub,
];

await rm(packageRoot, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true, force: true });

await rm(resolve(destination, hljsThemeDir), { recursive: true, force: true });
await mkdir(resolve(destination, hljsThemeDir), { recursive: true });
await writeFile(resolve(destination, hljsThemeStub), "/* Syntax colours live in src/styles.css. */\n");

const missing = [];
for (const asset of required) {
  try {
    await access(resolve(destination, asset));
  } catch {
    missing.push(asset);
  }
}

if (missing.length) {
  throw new Error(`Vditor 本地资源不完整，缺少：${missing.join(", ")}`);
}

console.log(`Synced Vditor assets to ${packageRoot}`);
