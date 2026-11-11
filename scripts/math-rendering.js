const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { url_for } = require('hexo-util');
const katex = require('katex');
const markedKatex = require('marked-katex-extension');

const distribution = dirname(require.resolve('katex'));
const assetDirectory = `assets/katex/${katex.version}`;
const stylesheet = readFileSync(join(distribution, 'katex-swap.min.css'), 'utf8') + `
.katex-display{display:flex;overflow-x:auto;overflow-y:hidden;padding:.25em 0}
.katex-display>.katex{flex:0 0 auto;margin-inline:auto}
`;
const fingerprint = createHash('sha256').update(stylesheet).digest('hex').slice(0, 12);
const stylesheetPath = `${assetDirectory}/katex-${fingerprint}.min.css`;

hexo.extend.filter.register('marked:use', (markedUse) => {
  markedUse(markedKatex({
    nonStandard: true,
    output: 'htmlAndMathml',
    strict: false,
    throwOnError: false,
    trust: false,
  }));
});

hexo.extend.filter.register('after_render:html', (html) => {
  const math = /<span class="katex(?:-display)?">/;
  if (!math.test(html)) return html;

  // Keep the link beside the formula so Swup also loads it on in-site navigation.
  const href = url_for.call(hexo, `/${stylesheetPath}`);
  return html.replace(/<link\b[^>]*\bdata-katex\b[^>]*>/g, '')
    .replace(math, `<link rel="stylesheet" href="${href}" data-katex>$&`);
}, 20);

hexo.extend.generator.register('katex-assets', () => {
  const fonts = new Set(Array.from(stylesheet.matchAll(/url\((fonts\/[^)]+)\)/g), match => match[1]));
  return [
    { path: stylesheetPath, data: stylesheet },
    { path: `${assetDirectory}/LICENSE`, data: readFileSync(join(distribution, '..', 'LICENSE')) },
    ...Array.from(fonts, font => ({
      path: `${assetDirectory}/${font}`,
      data: readFileSync(join(distribution, font)),
    })),
  ];
});
