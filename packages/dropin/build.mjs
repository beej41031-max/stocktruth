import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

// the adapter reaches for node:fs to read files from disk; none of that runs here
const noNode = {
  name: 'no-node',
  setup(b) {
    b.onResolve({ filter: /^node:/ }, (a) => ({ path: a.path, namespace: 'no-node' }));
    b.onLoad({ filter: /.*/, namespace: 'no-node' }, () => ({
      contents: 'export const readFileSync = () => { throw new Error("no disk in the browser"); }; export const join = (...p) => p.join("/");',
      loader: 'js',
    }));
  },
};

const out = await build({
  entryPoints: [join(root, 'src/app.ts')],
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  minify: true,
  legalComments: 'none',
  loader: { '.csv': 'text' },
  plugins: [noNode],
});

const js = out.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const css = readFileSync(join(root, 'src/style.css'), 'utf8');
const csp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'";

const html = `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>StockTruth: Shopify against your 3PL</title>
<style>${css}</style>
</head>
<body>
<script>${js}</script>
</body>
</html>
`;

mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist/stocktruth-dropin.html'), html);

// the finished page also sits at the top of the repository, so it can be
// opened with a double click before anyone reads about workspaces
writeFileSync(join(root, '../../stocktruth-dropin.html'), html);
console.log(`stocktruth-dropin.html  ${(html.length / 1024).toFixed(0)} KB`);
