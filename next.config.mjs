/** @type {import('next').NextConfig} */
const nextConfig = {
  // Cross-origin isolation lets the built-in AI voices use several CPU cores (much faster).
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
