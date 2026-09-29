/**
 * The collab-server's public URL. Read at build time: rewrites are compiled
 * into the build, so changing it needs a rebuild, not a restart.
 */
const COLLAB_SERVER_URL = process.env.NEXT_PUBLIC_COLLAB_SERVER_URL || "http://localhost:4000";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Emit a self-contained server bundle with only the modules actually
  // imported, so the runtime image does not carry the whole workspace
  // node_modules. See apps/web/Dockerfile.
  output: "standalone",

  // The browser talks only to this origin, and the API is proxied behind it.
  // That makes the session cookie first-party: the web and API hosts are
  // separate sites (onrender.com is a public suffix), and a cookie shared
  // across sites is blocked by Safari and partitioned by Firefox.
  async rewrites() {
    return {
      // afterFiles: the web app's own routes (/api/health) win over the proxy.
      afterFiles: [
        { source: "/api/:path*", destination: `${COLLAB_SERVER_URL}/api/:path*` },
        // Socket.IO lives at /socket.io/ and needs the trailing slash kept.
        { source: "/socket.io/", destination: `${COLLAB_SERVER_URL}/socket.io/` },
      ],
    };
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // Never let a browser guess a different type than the one served.
          { key: "X-Content-Type-Options", value: "nosniff" },
          // Nobody has a reason to frame the app; this blocks clickjacking.
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          // HTTPS only, for a year. Render serves the site over TLS.
          { key: "Strict-Transport-Security", value: "max-age=31536000" },
        ],
      },
    ];
  },
  // Otherwise Next redirects /socket.io/ to /socket.io and the handshake 404s.
  skipTrailingSlashRedirect: true,
  experimental: {
    // A sleeping free-tier API takes up to a minute to wake; the default 30s
    // would fail the first request after idle.
    proxyTimeout: 120_000,
  },
};

export default nextConfig;
