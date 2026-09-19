/**
 * F5: the virtual LAN. Machines register under their Wi-Fi IP; HTTP
 * requests are plain objects that a target machine drains in its own
 * handleClient(). Time passes on the target while a client waits, so a
 * sketch's HTTPClient sees the same queuing behaviour as the real wire
 * (minus TCP itself, which the emulator has never modelled).
 */

export interface HttpResp {
  status: number;
  body: string;
}

export interface HttpReq {
  method: 'GET' | 'POST';
  uri: string;
  args: [string, string][];
  body: string;
  /** filled by the sketch's server.send(); null until then */
  resp?: HttpResp | null;
}

/** What a machine offers the LAN. */
export interface LanHost {
  readonly ip: string;
  /** queue a request for the host's server(s); answered in handleClient() */
  deliver(req: HttpReq): void;
  /** run the host's world by `ms` virtual milliseconds (its own clock) */
  pump(ms: number): void;
}

export class Lan {
  private hosts = new Map<string, LanHost>();

  register(host: LanHost): void {
    this.hosts.set(host.ip, host);
  }

  unregister(host: LanHost): void {
    if (this.hosts.get(host.ip) === host) this.hosts.delete(host.ip);
  }

  route(ip: string): LanHost | null {
    return this.hosts.get(ip) ?? null;
  }

  /** every registered IP, for the GUI's address hints */
  addresses(): string[] {
    return [...this.hosts.keys()];
  }
}

export const lan = new Lan();

/** `http://1.2.3.4:80/path?a=b` -> parts; null for anything not a plain IP URL. */
export function parseUrl(
  url: string,
): { ip: string; port: number; uri: string; args: [string, string][] } | null {
  const m = /^https?:\/\/([^/:?#]+)(?::(\d+))?([^?#]*)(\?[^#]*)?$/i.exec(url.trim());
  if (!m) return null;
  const ip = m[1];
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return null; // no DNS on the virtual LAN
  const path = m[3] && m[3].length ? m[3] : '/';
  const query = m[4] ? m[4].slice(1) : '';
  return { ip, port: m[2] ? Number(m[2]) : 80, uri: path, args: parseForm(query) };
}

/** `a=7&b=x` -> pairs; values are percent-decoded. */
export function parseForm(s: string): [string, string][] {
  const out: [string, string][] = [];
  if (!s) return out;
  for (const part of s.split('&')) {
    if (!part.length) continue;
    const eq = part.indexOf('=');
    const k = decodeURIComponent((eq < 0 ? part : part.slice(0, eq)).replace(/\+/g, ' '));
    const v = eq < 0 ? '' : decodeURIComponent(part.slice(eq + 1).replace(/\+/g, ' '));
    out.push([k, v]);
  }
  return out;
}
