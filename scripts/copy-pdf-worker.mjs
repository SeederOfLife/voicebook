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
mkdirSync(join(root, "public/voice"), { recursive: true });

// Built-in AI voices: the engine and its WebAssembly runtime, served from this site.
for (const [from, to] of [
  ["node_modules/kokoro-js/dist/kokoro.web.js", "public/voice/kokoro.web.js"],
  ["node_modules/@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.mjs", "public/voice/ort-wasm-simd-threaded.jsep.mjs"],
  ["node_modules/@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.wasm", "public/voice/ort-wasm-simd-threaded.jsep.wasm"],
]) {
  if (existsSync(join(root, from))) copyFileSync(join(root, from), join(root, to));
  else console.warn("[copy-assets] missing", from);
}
copyFileSync(src, join(root, "public/pdf.worker.min.mjs"));
console.log("[copy-pdf-worker] copied", src.replace(root + "/", ""));
