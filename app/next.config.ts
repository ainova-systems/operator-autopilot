import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@operator/core", "@operator/adapters"],
  // The engine and shared packages use NodeNext module resolution and emit
  // `.js` extensions on their relative imports. Next.js (webpack) uses
  // bundler-style resolution by default, which does not map `.js` → `.ts`.
  // Tell it to try the TypeScript source when the `.js` target is missing.
  webpack: (config) => {
    config.resolve = config.resolve ?? {};
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
  // Prevent webpack from trying to bundle Node-native `.node` files.
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
