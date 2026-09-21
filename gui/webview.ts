/**
 * Pure helpers behind the HTTP panel's Page view (F3.3): they turn clicks
 * and form submits inside the rendered sketch page into LAN fetch requests.
 * Kept DOM-free so the link/form semantics are unit-testable.
 */

/** Absolute navigable http(s) URL for `href` served from `base`, else null. */
export function resolveHref(base: string, href: string | null): string | null {
  if (!href) return null;
  const h = href.trim();
  if (!h || h.startsWith('#')) return null;
  if (/^(javascript|mailto|tel|data):/i.test(h)) return null;
  try {
    const u = new URL(h, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.href;
  } catch {
    return null;
  }
}

/** Body sniff for "render this as a page": documents and bare fragments. */
export function looksHtml(body: string): boolean {
  return /^\s*<(?:!doctype\s+html|html|body|head|a |div|p |span|h1|table|br|hr|center|b |>)/i.test(body);
}

export interface FormDescriptor {
  method: string;
  action: string;
  fields: Record<string, string>;
}

export interface FormRequest {
  method: 'GET' | 'POST';
  url: string;
  body: string;
}

/**
 * Form submit -> the request it makes against the sketch's web server.
 * Fields go through URLSearchParams, so spaces encode as '+' exactly like a
 * real browser's application/x-www-form-urlencoded body (or GET query).
 */
export function formRequest(pageUrl: string, form: FormDescriptor): FormRequest {
  const method: 'GET' | 'POST' = form.method.toUpperCase() === 'POST' ? 'POST' : 'GET';
  let url: URL;
  try {
    url = new URL(form.action || pageUrl, pageUrl);
  } catch {
    url = new URL(pageUrl);
  }
  const params = new URLSearchParams(Object.entries(form.fields));
  if (method === 'GET') {
    // an action's own query survives; submitted fields are appended
    for (const [k, v] of params) url.searchParams.append(k, v);
    return { method, url: url.href, body: '' };
  }
  return { method, url: url.href, body: params.toString() };
}
