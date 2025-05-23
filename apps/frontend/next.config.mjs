/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: process.env.NODE_ENV === 'development' 
          ? 'http://backend:3001/api/:path*'  // Use service name in Docker network
          : 'http://localhost:3001/api/:path*', // Use localhost in production
      },
    ];
  },
};

export default nextConfig; 