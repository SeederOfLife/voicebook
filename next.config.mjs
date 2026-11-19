// Two ways to build:
//  - normal (Vercel, Hugging Face Space): the app with its server (voice, AI);
//  - STATIC_EXPORT=1 (GitHub Pages): only the pages and files, under NEXT_PUBLIC_BASE_PATH,
//    calling a separate voice server (NEXT_PUBLIC_API_BASES).
const STATIC = process.env.STATIC_EXPORT === "1";
const BASE = process.env.NEXT_PUBLIC_BASE_PATH || "";
// Sites allowed to call this server's voice and AI (the GitHub Pages site).
const CORS_ORIGIN = process.env.CORS_ORIGIN || "https://seederoflife.github.io";

/** @type {import('next').NextConfig} */
const nextConfig = STATIC
  ? { output: "export", basePath: BASE || undefined, trailingSlash: true, images: { unoptimized: true } }
  : {
  // The studio voice runs a native speech runtime on the server: load these straight
  // from node_modules instead of bundling them.
  serverExternalPackages: ["onnxruntime-node", "phonemizer"],

  // Files the studio voice reads at run time (the voices), which must ship with the function.
  outputFileTracingIncludes: {
    "/api/voice": [
      "./node_modules/kokoro-js/voices/a*.bin",
      "./node_modules/kokoro-js/voices/b*.bin",
      // The speech runtime's shared library sits next to its Node binding and is loaded by name.
      "./node_modules/onnxruntime-node/bin/napi-v*/linux/*/libonnxruntime.so.1",
      "./node_modules/onnxruntime-node/bin/napi-v*/linux/*/libonnxruntime_providers_shared.so",
      "./node_modules/onnxruntime-node/bin/napi-v*/linux/*/onnxruntime_binding.node",
    ],
  },

  // Keep the server function small: leave out other platforms' binaries, the GPU
  // libraries, and browser-only packages.
  outputFileTracingExcludes: {
    "*": [
      "./node_modules/onnxruntime-node/bin/napi-v*/darwin/**",
      "./node_modules/onnxruntime-node/bin/napi-v*/win32/**",
      "./node_modules/onnxruntime-node/bin/napi-v*/linux/x64/libonnxruntime_providers_cuda.so",
      "./node_modules/onnxruntime-node/bin/napi-v*/linux/x64/libonnxruntime_providers_tensorrt.so",
      "./node_modules/onnxruntime-node/bin/napi-v*/linux/*/libonnxruntime.so.1.*",
      "./node_modules/kokoro-js/voices/[!ab]*.bin",
      "./node_modules/onnxruntime-web/**",
      "./node_modules/@huggingface/**",
      "./node_modules/kokoro-js/dist/**",
      "./node_modules/sharp/**",
      "./node_modules/@img/**",
      "./public/voice/**",
    ],
  },

  // Cross-origin isolation lets on-device voices use several CPU cores on computers.
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
        ],
      },
      {
        // The GitHub Pages site may use this server.
        source: "/api/:path*",
        headers: [
          { key: "Access-Control-Allow-Origin", value: CORS_ORIGIN },
          { key: "Access-Control-Allow-Methods", value: "GET, POST, OPTIONS" },
          { key: "Access-Control-Allow-Headers", value: "content-type, authorization, x-app-password, x-access" },
          { key: "Access-Control-Expose-Headers", value: "x-audio-seconds, x-took-seconds, x-cpu-seconds, x-voice-model, x-instance" },
          { key: "Access-Control-Max-Age", value: "86400" },
          { key: "Cross-Origin-Resource-Policy", value: "cross-origin" },
          { key: "Vary", value: "Origin" },
        ],
      },
      {
        // The Android app: download as a file the phone offers to install.
        source: "/download/:file(.*\\.apk)",
        headers: [
          { key: "Content-Type", value: "application/vnd.android.package-archive" },
          { key: "Content-Disposition", value: "attachment" },
          { key: "Cache-Control", value: "public, max-age=300" },
        ],
      },
    ];
  },
};
export default nextConfig;
