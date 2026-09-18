import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
export default {
  transpilePackages: ['@stocktruth/engine'],
  outputFileTracingRoot: resolve(here, '../..'),
  // pg opens real sockets; it must not be bundled into the server build.
  serverExternalPackages: ['pg'],
  webpack(config) {
    // The tsconfig paths alias is not picked up reliably in an ESM package,
    // so it is stated here too rather than left to chance.
    config.resolve.alias['@'] = resolve(here);
    return config;
  },
};
