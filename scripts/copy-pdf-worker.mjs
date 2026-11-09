// Copies the pdf.js worker into /public so the browser can load it.
// Runs automatically after `npm install` (also on Vercel).
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const candidates = [
  "node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs",
  "node_modules/pdfjs-dist/build/pdf.worker.min.mjs",
];
const src = candidates.map((c) => join(root, c)).find((p) => existsSync(p));
if (!src) {
  console.warn("[copy-pdf-worker] pdf.js worker not found, skipping");
  process.exit(0);
}
mkdirSync(join(root, "public"), { recursive: true });
copyFileSync(src, join(root, "public/pdf.worker.min.mjs"));
console.log("[copy-pdf-worker] copied", src.replace(root + "/", ""));
