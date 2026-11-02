import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(process.cwd(), 'public');
const required = ['index.html', '2025/02/26/hello-world/index.html', 'archives/index.html', 'tags/index.html', 'categories/index.html', 'about/index.html', 'atom.xml', 'search.xml', 'images/covers/default.svg', 'images/avatar.svg', '.nojekyll'];
for (const path of required) assert(existsSync(join(root, path)), `Missing generated file: ${path}`);

const home = readFileSync(join(root, 'index.html'), 'utf8');
const post = readFileSync(join(root, '2025/02/26/hello-world/index.html'), 'utf8');
for (const [name, html] of [['home', home], ['post', post]]) {
  assert(html.includes('Str Cat'), `${name}: missing blog title`);
  assert(html.includes('redefine'), `${name}: Redefine theme is missing`);
  assert(!html.includes('http://example.com'), `${name}: default example.com URL remains`);
  assert(!html.includes('hexo-theme-cards'), `${name}: previous theme remains`);
  assert(html.includes('/images/covers/default.svg'), `${name}: article cover is missing`);
  for (const match of html.matchAll(/(?:src|href)=["'](\/[^"']*)["']/g)) {
    const path = decodeURIComponent(match[1].split(/[?#]/)[0]);
    if (path.startsWith('//')) continue;
    const file = join(root, path);
    assert(existsSync(file) || existsSync(join(file, 'index.html')), `${name}: broken internal URL ${path}`);
  }
}
assert(post.includes('Quick Start'), 'Original article content is missing');
assert(post.includes('https://wawoscarqaq.github.io/2025/02/26/hello-world/'), 'Original article URL is not preserved');
console.log('Verified Redefine pages, article cover, original permalink, and local assets.');
