const { execFileSync } = require('node:child_process');

// Pages caches static files. Give each published revision fresh stylesheet URLs.
const revision = (process.env.GITHUB_SHA || execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: hexo.base_dir,
  encoding: 'utf8',
})).trim().slice(0, 12);

hexo.extend.filter.register('after_render:html', (html) => html.replace(/<link\b[^>]*>/gi, (tag) => {
  // Math styles already have a content fingerprint and can stay cached across posts.
  if (!/\brel=["']stylesheet["']/i.test(tag) || /\bdata-katex\b/.test(tag)) return tag;
  return tag.replace(/\bhref=(["'])(\/(?!\/)[^"']+\.css)\1/i,
    (_, quote, path) => `href=${quote}${path}?v=${revision}${quote}`);
}));
