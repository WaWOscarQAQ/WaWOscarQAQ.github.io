// Keep the wide desktop thumbnail while showing both faces on narrower screens.
hexo.extend.filter.register('after_render:html', (html) => html.replace(
  /(<a\b[^>]*>\s*)(<img\b[^>]*\bsrc=["']\/images\/covers\/linux-md-thumbnail\.webp["'][^>]*>)/g,
  (_, link, img) => link + '<picture><source media="(max-width: 640px)" '
    + 'srcset="/images/covers/linux-md.webp" type="image/webp">'
    + img + '</picture>'
));
