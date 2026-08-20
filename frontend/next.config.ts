import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // Without this, Turbopack walks up and finds the backend's
  // package-lock.json in the parent Sonar/ folder and guesses that's the
  // project root instead of frontend/ itself.
  turbopack: {
    root: path.join(__dirname),
  },
};

export default nextConfig;
