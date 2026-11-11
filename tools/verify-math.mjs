import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Hexo from 'hexo';

const hexo = new Hexo(process.cwd(), { silent: true });
try {
  await hexo.init();
  // Hexo applies page HTML filters after rendering Markdown fragments.
  const render = async text => hexo.execFilter('_after_html_render',
    await hexo.render.render({ text, engine: 'md' }), { context: hexo });
  const inline = await render('行内公式$x^2 + y^2 = z^2$正常，另一个公式$\\frac{1}{2}$。');
  assert.equal((inline.match(/class="katex"/g) || []).length, 2, 'Chinese inline math was not rendered');
  assert.equal((inline.match(/data-katex/g) || []).length, 1, 'Math stylesheet should be linked once');
  assert(!inline.includes('katex-display'), 'Inline math became a display block');

  const source = readFileSync('source/_posts/md raid.md', 'utf8');
  const formula = source.match(/^\$\$\n[\s\S]*?\n\$\$/m)?.[0];
  assert(formula, 'RAID formula fixture is missing');
  const block = await render(formula);
  assert(block.includes('katex-display') && block.includes('<math'), 'Display math or accessible MathML is missing');
  assert(!block.includes('katex-error'), 'The existing Chinese RAID formula failed to render');
  assert(block.includes('disk\\_size') && block.includes('chunk\\_sectors'), 'Markdown consumed LaTeX escapes');

  const literals = await render('`$a_b$` and `$HOME`\n\n```sh\nprintf "$HOME"\n```\n\n价格 \\$5 和 \\$10。');
  assert(!literals.includes('data-katex') && !literals.includes('class="katex'), 'Code or escaped currency was treated as math');
  assert(literals.includes('$a_b$') && literals.includes('$HOME'), 'Code content was changed');

  const raidPath = 'public/2026/11/11/md raid/index.html';
  const raid = readFileSync(raidPath, 'utf8');
  const link = raid.match(/<link\b[^>]*href="([^"]+)"[^>]*data-katex[^>]*>/);
  assert(link && raid.indexOf(link[0]) > raid.indexOf('id="swup"'), 'Math CSS must travel with the Swup content');
  assert.equal((raid.match(/data-katex/g) || []).length, 1, 'Generated math page has duplicate stylesheets');
  assert(!raid.includes('katex-error') && raid.includes('class="katex-display"'), 'Published RAID math is broken');
  assert(!/<script[^>]*src=["'][^"']*(?:katex|mathjax)/i.test(raid), 'Math must not load a browser rendering script');

  const cssFile = join('public', decodeURIComponent(link[1].split(/[?#]/)[0]));
  assert(existsSync(cssFile), 'Local math stylesheet is missing');
  const css = readFileSync(cssFile, 'utf8');
  assert(css.includes('font-display:swap'), 'Math fonts must not block text display');
  for (const [, font] of css.matchAll(/url\((fonts\/[^)]+)\)/g)) {
    assert(existsSync(join(dirname(cssFile), font)), `Missing math font: ${font}`);
  }
  for (const page of ['index.html', '2025/02/26/hello-world/index.html', '2026/11/09/Linux_io_trace/index.html']) {
    assert(!readFileSync(join('public', page), 'utf8').includes('data-katex'), `Non-math page loads math assets: ${page}`);
  }
  console.log('Verified inline/display math, Chinese and escaped LaTeX, code/currency, conditional local assets, and Swup support.');
} finally {
  await hexo.exit();
}
