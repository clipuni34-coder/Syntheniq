/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Fully client-side studio: builds to static HTML for Cloudflare Pages.
  output: 'export',
};

export default nextConfig;
