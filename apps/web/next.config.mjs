/** @type {import('next').NextConfig} */
const nextConfig = {
  // PilotSwarm pulls in duroxide (native/binary). Don't bundle it.
  // Let Node require it at runtime from node_modules.
  serverExternalPackages: ["duroxide"],
};

export default nextConfig;

