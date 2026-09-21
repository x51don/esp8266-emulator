/**
 * HTTP panel (F5): the browser as a client of the sketch's web server.
 * Requests go through the virtual LAN, so the sketch must reach
 * handleClient() on its own - response times show the loop period.
 *
 * F3.3 "Page" view: HTML answers render in a sandboxed iframe, and links /
 * form submits inside them navigate through the same LAN calls - turning a
 * full ESP8266WebServer sketch (roleta UI) into a browsable page.
 */

import { useEffect, useRef, useState } from 'react';
import type { HttpResp } from '../../core/lan';
import { formRequest, looksHtml, resolveHref } from '../webview';

interface Props {
  ip: string;
  running: boolean;
  onFetch: (method: 'GET' | 'POST', url: string, body: string) => HttpResp | null;
}

interface Entry {
  id: number;
  method: string;
  url: string;
  resp: HttpResp | null;
  ms: number;
}

interface Page {
  url: string;
  html: string;
}

let nextId = 1;

/** Collect a form's name/value pairs like a browser would at submit time. */
function formFields(form: HTMLFormElement): Record<string, string> {
  const out: Record<string, string> = {};
  for (const el of Array.from(form.elements)) {
    const f = el as HTMLInputElement;
    if (!f.name || f.disabled || f.tagName === 'FIELDSET') continue;
    const type = (f.type ?? '').toLowerCase();
    if ((type === 'checkbox' || type === 'radio') && !f.checked) continue;
    if (f.tagName === 'SELECT') {
      const sel = f as unknown as HTMLSelectElement;
      out[f.name] = Array.from(sel.selectedOptions).map((o) => o.value).join(',');
      continue;
    }
    if (f.tagName === 'INPUT' || f.tagName === 'TEXTAREA' || type === 'button') {
      if (type === 'submit' || type === 'button' || type === 'reset') continue;
      out[f.name] = f.value ?? '';
    }
  }
  return out;
}

export function HttpPanel({ ip, running, onFetch }: Props) {
  const [method, setMethod] = useState<'GET' | 'POST'>('GET');
  const [url, setUrl] = useState(`http://${ip}/`);
  const [body, setBody] = useState('');
  const [log, setLog] = useState<Entry[]>([]);
  const [view, setView] = useState<'log' | 'page'>('log');
  const [page, setPage] = useState<Page | null>(null);
  const backRef = useRef<Page[]>([]);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const pageRef = useRef<Page | null>(null);
  pageRef.current = page;

  // a sketch with a static IP renumbers its chip at connect (roleta -> .150);
  // follow it in the URL box until the user edits the field themselves
  const autoUrlRef = useRef(`http://${ip}/`);
  useEffect(() => {
    const next = `http://${ip}/`;
    if (url === autoUrlRef.current) setUrl(next);
    autoUrlRef.current = next;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ip]);

  const openPage = (p: Page, from?: Page | null) => {
    if (from) backRef.current = [...backRef.current.slice(-29), from];
    setPage(p);
    setView('page');
  };

  const send = () => {
    const t0 = performance.now();
    const resp = onFetch(method, url, body);
    const ms = Math.round(performance.now() - t0);
    setLog((l) => [{ id: nextId++, method, url, resp, ms }, ...l].slice(0, 50));
    if (resp && looksHtml(resp.body)) openPage({ url, html: resp.body }, pageRef.current);
  };

  const navigate = (target: string, m: 'GET' | 'POST', b: string) => {
    const from = pageRef.current;
    const resp = onFetch(m, target, b);
    if (resp && looksHtml(resp.body)) openPage({ url: target, html: resp.body }, from);
    else if (resp) openPage({ url: target, html: `<pre style="font:13px ui-monospace,monospace;padding:10px;white-space:pre-wrap">${resp.status} - ${target}\n\n${resp.body || '(empty body)'}</pre>` }, from);
    else
      openPage(
        {
          url: target,
          html: `<pre style="font:13px ui-monospace,monospace;padding:10px">${m} ${target}

no response.
${running ? 'is the sketch reaching server.handleClient()?' : 'start the sketch with Run first.'}
this chip currently answers at http://${ip}/ (a sketch calling\nWiFi.config() renumbers it - use the address shown in the badge)</pre>`,
        },
        from,
      );
    setLog((l) => [{ id: nextId++, method: m, url: target, resp, ms: 0 }, ...l].slice(0, 50));
  };

  const goBack = () => {
    const prev = backRef.current.pop();
    if (prev) setPage(prev);
  };

  // srcDoc + sandbox="allow-same-origin": scripts in the served page cannot
  // touch the emulator app, but the parent can still wire link/submit taps.
  const wire = () => {
    const doc = frameRef.current?.contentDocument;
    if (!doc) return;
    doc.addEventListener('click', (e) => {
      const a = (e.target as Element | null)?.closest?.('a[href]');
      if (!a) return;
      e.preventDefault();
      const href = resolveHref(pageRef.current?.url ?? '', a.getAttribute('href'));
      if (href) navigate(href, 'GET', '');
    });
    doc.addEventListener('submit', (e) => {
      const form = e.target as HTMLFormElement | null;
      if (!form || form.tagName !== 'FORM') return;
      e.preventDefault();
      const r = formRequest(pageRef.current?.url ?? '', {
        method: form.getAttribute('method') ?? 'GET',
        action: form.getAttribute('action') ?? '',
        fields: formFields(form),
      });
      navigate(r.url, r.method, r.body);
    });
  };

  const tab = (v: 'log' | 'page', label: string, badge?: number | string) => (
    <button
      className={`mini-btn${view === v ? ' mini-btn-on' : ''}`}
      onClick={() => setView(v)}
      disabled={v === 'page' && !page}
    >
      {label}
      {v === 'log' && log.length ? ` (${badge ?? log.length})` : ''}
    </button>
  );

  return (
    <div className="serial-panel">
      <div className="panel-title">
        HTTP client
        {tab('log', 'Log')}
        {tab('page', 'Page')}
        {view === 'page' && (
          <>
            <button className="mini-btn" onClick={goBack} disabled={!backRef.current.length}>
              &larr; back
            </button>
            <span className="http-url" title="current page">{page?.url}</span>
          </>
        )}
        <span className="spacer" />
        <span className="http-ip" title="this machine's address on the virtual LAN">
          {running ? ip : 'offline'}
        </span>
      </div>
      <div className="http-bar">
        <select value={method} onChange={(e) => setMethod(e.target.value as 'GET' | 'POST')}>
          <option>GET</option>
          <option>POST</option>
        </select>
        <input
          className="http-url"
          value={url}
          spellCheck={false}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') send();
          }}
          placeholder={`http://${ip}/TARGET?value=50`}
        />
        <button className="mini-btn" onClick={send} disabled={!running}>
          send
        </button>
      </div>
      {method === 'POST' && view === 'log' && (
        <textarea
          className="http-body"
          value={body}
          spellCheck={false}
          onChange={(e) => setBody(e.target.value)}
          placeholder="form body: a=7&b=x"
          rows={2}
        />
      )}
      {view === 'log' ? (
        <div className="serial-body">
          {log.length === 0 && (
            <div className="serial-empty">
              run the sketch, then GET http://{ip}/ - html answers open in the
              Page tab where their links and forms keep working
            </div>
          )}
          {log.map((e) => (
            <div key={e.id} className="http-entry">
              <span className={e.resp && e.resp.status < 400 ? 'http-ok' : 'http-bad'}>
                {e.method} {e.url}
              </span>
              {e.resp ? (
                <>
                  <span className="http-status">
                    {' '}
                    &rarr; {e.resp.status}{' '}
                    <span className="serial-ts">({e.ms} ms cpu)</span>
                  </span>
                  <pre className="http-resp">{e.resp.body || '(empty body)'}</pre>
                </>
              ) : (
                <span className="http-bad"> &rarr; no response (timeout / not this machine)</span>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="http-frame-wrap">
          {page && (
            <iframe
              ref={frameRef}
              key={page.url + page.html.length}
              className="http-frame"
              title="sketch web server"
              sandbox="allow-same-origin"
              srcDoc={page.html}
              onLoad={wire}
            />
          )}
        </div>
      )}
    </div>
  );
}
