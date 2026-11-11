import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
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

  const formula = String.raw`$$
\text{disk\_size} = (\text{当前设备起始逻辑扇区} / \text{chunk\_sectors}) \% \text{nb\_dev}
$$`;
  const block = await render(formula);
  assert(block.includes('katex-display') && block.includes('<math'), 'Display math or accessible MathML is missing');
  assert(!block.includes('katex-error'), 'The existing Chinese RAID formula failed to render');
  assert(block.includes('disk\\_size') && block.includes('chunk\\_sectors'), 'Markdown consumed LaTeX escapes');

  const literals = await render('`$a_b$` and `$HOME`\n\n```sh\nprintf "$HOME"\n```\n\n价格 \\$5 和 \\$10。');
  assert(!literals.includes('data-katex') && !literals.includes('class="katex'), 'Code or escaped currency was treated as math');
  assert(literals.includes('$a_b$') && literals.includes('$HOME'), 'Code content was changed');

  // Generated date paths depend on the build timezone; inspect every output page.
  for (const page of readdirSync('public', { recursive: true }).filter(file => file.endsWith('.html'))) {
    const html = readFileSync(join('public', page), 'utf8');
    const hasMath = /<span class="katex(?:-display)?">/.test(html);
    const links = Array.from(html.matchAll(/<link\b[^>]*href="([^"]+)"[^>]*data-katex[^>]*>/g));
    assert.equal(links.length, hasMath ? 1 : 0, `${page}: math stylesheet must load once, only when needed`);
    assert(!/<span class="katex-error"/.test(html), `${page}: formula failed to render`);
    assert(!/<script[^>]*src=["'][^"']*(?:katex|mathjax)/i.test(html), `${page}: browser math script is unnecessary`);
    if (hasMath) {
      assert(html.indexOf(links[0][0]) > html.indexOf('id="swup"'), `${page}: math CSS must travel with Swup content`);
    }
  }

  const link = block.match(/<link\b[^>]*href="([^"]+)"[^>]*data-katex[^>]*>/);
  assert(link, 'Math stylesheet was not linked');
  const cssFile = join('public', decodeURIComponent(link[1].split(/[?#]/)[0]));
  assert(existsSync(cssFile), 'Local math stylesheet is missing');
  const css = readFileSync(cssFile, 'utf8');
  assert(css.includes('font-display:swap'), 'Math fonts must not block text display');
  for (const [, font] of css.matchAll(/url\((fonts\/[^)]+)\)/g)) {
    assert(existsSync(join(dirname(cssFile), font)), `Missing math font: ${font}`);
  }
  console.log('Verified inline/display math, Chinese and escaped LaTeX, code/currency, conditional local assets, and Swup support.');
} finally {
  await hexo.exit();
}
