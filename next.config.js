/** @type {import('next').NextConfig} */
const nextConfig = {
  // Fix for pdf-parse in Next.js 14
  experimental: {
    serverComponentsExternalPackages: ["pdf-parse"],
  },
  
  // Ignore typescript/eslint errors for build
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  }
}

module.exports = nextConfig