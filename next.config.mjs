/** @type {import('next').NextConfig} */
const nextConfig = {
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
    ];
  },
};
export default nextConfig;
