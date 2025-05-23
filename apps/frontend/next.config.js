/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: 'http://backend:3001/api/:path*',
      },
    ];
  },
  // Remove experimental.serverActions as it's now default
  // Remove invalid timeout option from httpAgentOptions
  httpAgentOptions: {
    keepAlive: true
  },
  // Add environment variables
  env: {
    NEXT_PUBLIC_BACKEND_URL: process.env.NEXT_PUBLIC_BACKEND_URL || 'http://backend:3001'
  }
  // Remove api configuration as it's defined in route handlers
};

module.exports = nextConfig; 