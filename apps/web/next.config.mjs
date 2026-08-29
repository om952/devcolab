/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Emit a self-contained server bundle with only the modules actually
  // imported, so the runtime image does not carry the whole workspace
  // node_modules. See apps/web/Dockerfile.
  output: "standalone",
};

export default nextConfig;
