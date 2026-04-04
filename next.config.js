/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  experimental: {
    serverComponentsExternalPackages: ['pdf-parse', 'mammoth'],
  },
  // This is the critical fix:
  // Prevents Next.js from attempting to statically pre-render any page.
  // All pages render at request time — env vars are always available.
  output: 'standalone',
};

module.exports = nextConfig;
