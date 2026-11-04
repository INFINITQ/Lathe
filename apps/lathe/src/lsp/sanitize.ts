// Language servers send Markdown, which may carry HTML. Hovers and completion docs show it
// after this keeps only harmless formatting: no scripts, styles, frames, forms, images or
// event attributes, and links only to http(s).

const KEEP = new Set([
  'P',
  'BR',
  'HR',
  'EM',
  'STRONG',
  'B',
  'I',
  'U',
  'S',
  'DEL',
  'INS',
  'CODE',
  'PRE',
  'KBD',
  'SAMP',
  'VAR',
  'SUB',
  'SUP',
  'SMALL',
  'MARK',
  'A',
  'UL',
  'OL',
  'LI',
  'DL',
  'DT',
  'DD',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'BLOCKQUOTE',
  'TABLE',
  'THEAD',
  'TBODY',
  'TFOOT',
  'TR',
  'TH',
  'TD',
  'SPAN',
  'DIV',
  'DETAILS',
  'SUMMARY',
]);

/** Removed with everything inside them. */
const DROP = new Set([
  'SCRIPT',
  'STYLE',
  'IFRAME',
  'FRAME',
  'OBJECT',
  'EMBED',
  'TEMPLATE',
  'NOSCRIPT',
  'LINK',
  'META',
  'BASE',
  'FORM',
  'INPUT',
  'BUTTON',
  'TEXTAREA',
  'SELECT',
  'IMG',
  'PICTURE',
  'VIDEO',
  'AUDIO',
  'SOURCE',
  'SVG',
  'MATH',
  'CANVAS',
]);

interface Options {
  /** Keep <img>: `true` for embedded (data:) images; 'local' also for files beside the document,
   * whose path moves to data-local-src for the caller to load. */
  images?: boolean | 'local';
  /** Keep links to other files and to headings (#…), for the caller to handle. */
  localLinks?: boolean;
}

/** A path or a fragment, not a URL with a scheme (a drive letter isn't a scheme) and not a
 * network path (\\server\share, which Windows would reach out to). Browsers ignore spaces and
 * control characters in a URL ("java script:"), so the test does too. */
export function isLocal(value: string): boolean {
  const bare = [...value].filter((c) => c.charCodeAt(0) > 32).join('');
  return !!bare && !/^[\\/]{2}/.test(bare) && !/^[a-z][a-z0-9+.-]+:/i.test(bare);
}

function clean(parent: Node, options: Options) {
  for (const child of [...parent.childNodes]) {
    if (child.nodeType === Node.TEXT_NODE) continue;
    if (child.nodeType !== Node.ELEMENT_NODE) {
      child.remove();
      continue;
    }
    const element = child as Element;
    const tag = element.tagName.toUpperCase();
    if (options.images && tag === 'IMG') {
      const src = (element.getAttribute('src') ?? '').trim();
      if (options.images === 'local' && isLocal(src)) {
        element.setAttribute('data-local-src', src);
        element.removeAttribute('src');
      } else if (!/^data:image\/(png|jpe?g|gif|webp|svg\+xml)[;,]/i.test(src)) {
        element.remove();
        continue;
      }
      for (const attribute of [...element.attributes]) {
        const name = attribute.name.toLowerCase();
        const keep =
          name === 'src' ||
          name === 'alt' ||
          name === 'data-local-src' ||
          ((name === 'width' || name === 'height') && /^\d+%?$/.test(attribute.value));
        if (!keep) element.removeAttribute(attribute.name);
      }
      continue;
    }
    if (DROP.has(tag)) {
      element.remove();
      continue;
    }
    clean(element, options);
    if (!KEEP.has(tag)) {
      element.replaceWith(...element.childNodes);
      continue;
    }
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const href = attribute.value.trim();
      const keep =
        (tag === 'A' &&
          name === 'href' &&
          (/^https?:\/\//i.test(href) || (!!options.localLinks && isLocal(href)))) ||
        (name === 'class' && /^[\w\s-]*$/.test(attribute.value));
      if (!keep) element.removeAttribute(attribute.name);
    }
  }
}

/** Keeps only harmless formatting. With `images`, <img> stays too, for embedded (data:) images
 * only, as in notebook Markdown. */
export function sanitizeHTML(html: string, options: Options = {}): string {
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, 'text/html');
  clean(doc.body, options);
  return doc.body.innerHTML;
}
