import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
export default {
  // This is a workspace app. Keep tracing rooted at the repository so the
  // engine package is included in Vercel's server output.
  outputFileTracingRoot: resolve(here, '../..'),
  transpilePackages: ['@stocktruth/engine'],

  // pg opens real sockets; it must stay a server external.
  serverExternalPackages: ['pg'],

  webpack(config) {
    config.resolve.alias['@'] = resolve(here);
    return config;
  },
};
