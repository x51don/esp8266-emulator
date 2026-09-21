import { describe, expect, it } from 'vitest';
import { formRequest, looksHtml, resolveHref } from '../gui/webview';

describe('resolveHref', () => {
  it('root-relative link resolves against the served page', () => {
    expect(resolveHref('http://192.168.1.150/STATUS', '/TARGET?value=50'))
      .toBe('http://192.168.1.150/TARGET?value=50');
  });

  it('relative link resolves against the page directory', () => {
    expect(resolveHref('http://192.168.1.150/a/b', 'UP')).toBe('http://192.168.1.150/a/UP');
  });

  it('absolute URLs pass through (any peer on the virtual LAN)', () => {
    expect(resolveHref('http://192.168.1.150/', 'http://192.168.1.152/STOP'))
      .toBe('http://192.168.1.152/STOP');
  });

  it('javascript:, mailto: and bare fragments do not navigate', () => {
    expect(resolveHref('http://192.168.1.150/', 'javascript:void(0)')).toBeNull();
    expect(resolveHref('http://192.168.1.150/', 'mailto:x@y.z')).toBeNull();
    expect(resolveHref('http://192.168.1.150/', '#top')).toBeNull();
    expect(resolveHref('http://192.168.1.150/x', '#')).toBeNull();
  });
});

describe('looksHtml', () => {
  it('detects documents and bare fragments', () => {
    expect(looksHtml('<!DOCTYPE html>\n<html><body>hi</body></html>')).toBe(true);
    expect(looksHtml('  <HTML>')).toBe(true);
    expect(looksHtml('<a href="/UP">UP</a>')).toBe(true);
  });

  it('plain answers are not pages', () => {
    expect(looksHtml('TARGET set')).toBe(false);
    expect(looksHtml('')).toBe(false);
    expect(looksHtml('{"v":1}')).toBe(false);
  });
});

describe('formRequest', () => {
  it('post form serializes fields into the body', () => {
    const r = formRequest('http://ip/STATUS', {
      method: 'post', action: '/login', fields: { user: 'a', pass: 'x y' },
    });
    expect(r).toEqual({ method: 'POST', url: 'http://ip/login', body: 'user=a&pass=x+y' });
  });

  it('get form appends fields to the action query', () => {
    const r = formRequest('http://ip/', {
      method: 'get', action: '/SEARCH', fields: { q: 'a b' },
    });
    expect(r.method).toBe('GET');
    expect(r.url).toBe('http://ip/SEARCH?q=a+b');
    expect(r.body).toBe('');
  });

  it('empty action posts to the current page', () => {
    const r = formRequest('http://ip/x/y', { method: 'POST', action: '', fields: {} });
    expect(r.url).toBe('http://ip/x/y');
  });
});
