/**
 * HTTP panel (F5): the browser as a client of the sketch's web server.
 * Requests go through the virtual LAN, so the sketch must reach
 * handleClient() on its own - response times show the loop period.
 */

import { useState } from 'react';
import type { HttpResp } from '../../core/lan';

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

let nextId = 1;

export function HttpPanel({ ip, running, onFetch }: Props) {
  const [method, setMethod] = useState<'GET' | 'POST'>('GET');
  const [url, setUrl] = useState(`http://${ip}/`);
  const [body, setBody] = useState('');
  const [log, setLog] = useState<Entry[]>([]);

  const send = () => {
    const t0 = performance.now();
    const resp = onFetch(method, url, body);
    const ms = Math.round(performance.now() - t0);
    setLog((l) => [{ id: nextId++, method, url, resp, ms }, ...l].slice(0, 50));
  };

  return (
    <div className="serial-panel">
      <div className="panel-title">
        HTTP client
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
      {method === 'POST' && (
        <textarea
          className="http-body"
          value={body}
          spellCheck={false}
          onChange={(e) => setBody(e.target.value)}
          placeholder="form body: a=7&b=x"
          rows={2}
        />
      )}
      <div className="serial-body">
        {log.length === 0 && (
          <div className="serial-empty">
            run the sketch, then GET http://{ip}/ - the server answers inside
            handleClient()
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
    </div>
  );
}
