import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
export default {
  // Keep Next inside this monorepo. Bijan has other npm projects higher up the
  // Downloads tree and Next is far too interested in them.
  outputFileTracingRoot: resolve(here, '../..'),
  // The engine is local TypeScript, not a published npm package. Tell Next to compile it.
  transpilePackages: ['@stocktruth/engine'],
  // pg opens real sockets; it must not be bundled into the server build.
  serverExternalPackages: ['pg'],
  webpack(config) {
    // The tsconfig paths alias is not picked up reliably in an ESM package,
    // so it is stated here too rather than left to chance.
    config.resolve.alias['@'] = resolve(here);
    return config;
  },
};
