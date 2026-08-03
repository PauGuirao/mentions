import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // Cloudflare Workers deployment (OpenNext) has no image optimizer.
  images: { unoptimized: true },
};

export default withMDX(config);
