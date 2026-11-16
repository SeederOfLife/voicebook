import type { MetadataRoute } from "next";

// Makes Voicebook installable: on Android, Chrome turns it into a real app (a WebAPK)
// with its own icon, that opens full screen and works offline.
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Voicebook — AI audiobook reader",
    short_name: "Voicebook",
    description: "Hear your books, PDFs and texts read aloud by natural AI voices.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#14110f",
    theme_color: "#14110f",
    categories: ["books", "education", "entertainment"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
