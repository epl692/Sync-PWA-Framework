/** index.html and the web manifest (contracts/pwa-output.md). */

import type { AppConfig } from '@sync/modules';

export function contentSecurityPolicy(connectSrc: readonly string[] = []): string {
  // `blob:` is how the runtime module loader executes the exact bytes it verified (research R-08).
  return [
    "default-src 'self'",
    "script-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    `connect-src ${["'self'", ...connectSrc].join(' ')}`,
    "img-src 'self' data: blob:",
  ].join('; ');
}

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

export const DEFAULT_TEMPLATE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title></title>
  </head>
  <body>
    <div id="app"></div>
  </body>
</html>
`;

export interface HtmlOptions {
  template: string;
  config: AppConfig;
  script: string;
  styles: readonly string[];
  hasMaskable: boolean;
}

/** Injects the head tags and the module script into the app's template. Throws if the template has no head or body. */
export function renderIndexHtml(o: HtmlOptions): string {
  if (!/<\/head>/i.test(o.template) || !/<\/body>/i.test(o.template)) {
    throw new Error('index.template.html must contain </head> and </body>');
  }
  const head = [
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<meta name="theme-color" content="${escapeAttr(o.config.themeColor)}" />`,
    `<meta http-equiv="Content-Security-Policy" content="${escapeAttr(contentSecurityPolicy(o.config.connectSrc))}" />`,
    '<link rel="manifest" href="manifest.webmanifest" />',
    '<link rel="icon" href="icons/icon-192.png" type="image/png" />',
    '<link rel="apple-touch-icon" href="icons/icon-192.png" />',
    ...o.styles.map((s) => `<link rel="stylesheet" href="${escapeAttr(s)}" />`),
  ].join('\n    ');
  let html = o.template.replace(/<\/head>/i, `    ${head}\n  </head>`);
  if (!/<title>[^<]+<\/title>/i.test(html)) html = html.replace(/<title>\s*<\/title>/i, `<title>${escapeAttr(o.config.name)}</title>`);
  return html.replace(/<\/body>/i, `    <script type="module" src="${escapeAttr(o.script)}"></script>\n  </body>`);
}

export function renderWebManifest(config: AppConfig, hasMaskable: boolean): string {
  const icons: Array<Record<string, string>> = [
    { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
  ];
  if (hasMaskable) icons.push({ src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' });
  return JSON.stringify(
    {
      id: './',
      name: config.name,
      short_name: config.shortName ?? config.name,
      ...(config.description ? { description: config.description } : {}),
      start_url: './',
      scope: './',
      display: 'standalone',
      theme_color: config.themeColor,
      background_color: config.backgroundColor ?? '#ffffff',
      icons,
    },
    null,
    2,
  );
}
