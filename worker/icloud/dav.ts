import { SaxesParser } from 'saxes';
import { ApiError } from '../database';
import { providerFetch } from '../calendar/requestBudget';
export const DAV = 'DAV:',
  CAL = 'urn:ietf:params:xml:ns:caldav',
  APPLE = 'http://apple.com/ns/ical/';
export interface Node {
  name: string;
  ns: string;
  text: string;
  children: Node[];
  attrs: Record<string, string>;
}
export const children = (node: Node, name: string, ns = DAV) =>
  node.children.filter((n) => n.name === name && n.ns === ns);
export const child = (node: Node, name: string, ns = DAV) => children(node, name, ns)[0];
export const value = (node: Node, name: string, ns = DAV) => child(node, name, ns)?.text.trim();
export const escapeXml = (v: string) =>
  v
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
export function xml(text: string): Node {
  try {
    if (text.length > 2_000_000 || /<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error();
    const parser = new SaxesParser({ xmlns: true });
    let root: Node | undefined;
    const stack: Node[] = [];
    let count = 0;
    parser.on('opentag', (tag) => {
      if (++count > 50000 || stack.length > 24) throw new Error();
      const node: Node = {
        name: tag.local,
        ns: tag.uri,
        text: '',
        children: [],
        attrs: Object.fromEntries(Object.values(tag.attributes).map((a) => [a.local, a.value])),
      };
      if (stack.length) stack.at(-1)!.children.push(node);
      else root = node;
      stack.push(node);
    });
    const append = (text: string) => {
      if (stack.length) stack.at(-1)!.text += text;
    };
    parser.on('text', append);
    parser.on('cdata', append);
    parser.on('closetag', () => {
      stack.pop();
    });
    parser.on('error', () => {
      throw new Error();
    });
    parser.write(text).close();
    if (!root) throw new Error();
    return root;
  } catch {
    throw new ApiError(
      502,
      'iCloud returned an invalid calendar response. Saved events are unchanged.',
      'icloud_response',
    );
  }
}
export function safeUrl(href: string, base = 'https://caldav.icloud.com/') {
  try {
    const u = new URL(href, base);
    if (
      u.protocol !== 'https:' ||
      u.port ||
      u.username ||
      u.password ||
      u.hash ||
      u.search ||
      !/^(?:caldav|p\d+-caldav)\.icloud\.com$/.test(u.hostname)
    )
      throw new Error();
    return u.href;
  } catch {
    throw new ApiError(502, 'iCloud returned an unsupported server address.', 'icloud_address');
  }
}
export function resourceUrl(href: string, calendar: string) {
  const result = safeUrl(href, calendar),
    base = new URL(calendar);
  if (!result.startsWith(base.origin + base.pathname.replace(/\/?$/, '/')))
    throw new ApiError(502, 'iCloud returned a resource outside this calendar.', 'icloud_response');
  return result;
}
export class DavError extends ApiError {
  constructor(
    public davStatus: number,
    public invalidToken = false,
    public unsupportedExpansion = false,
  ) {
    super(
      davStatus === 401 ? 401 : 502,
      davStatus === 401
        ? 'iCloud sign-in failed. Generate a new app-specific password and reconnect.'
        : 'iCloud could not be read. Check permissions or try again later.',
      davStatus === 401 ? 'icloud_authorization' : 'icloud_unavailable',
    );
  }
}
export function client(account: string, password: string, budget?: { remaining: number }) {
  const auth = btoa(
    Array.from(new TextEncoder().encode(`${account}:${password}`), (b) =>
      String.fromCharCode(b),
    ).join(''),
  );
  let calls = 0;
  const deadline = Date.now() + 90_000;
  return async (href: string, method: 'PROPFIND' | 'REPORT', body: string, depth = '0') => {
    let url = safeUrl(href);
    for (let redirects = 0; redirects < 4; redirects++) {
      if (++calls > 40 || Date.now() > deadline)
        throw new ApiError(
          502,
          'iCloud sync reached its safety limit. Saved events are unchanged.',
          'icloud_limit',
        );
      let response: Response;
      try {
        response = await providerFetch(
          url,
          {
            method,
            headers: {
              Authorization: `Basic ${auth}`,
              'Content-Type': 'application/xml; charset=utf-8',
              Depth: depth,
            },
            body,
            redirect: 'manual',
            signal: AbortSignal.timeout(Math.min(15000, deadline - Date.now())),
          },
          budget,
        );
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(
          502,
          'iCloud could not be reached. Saved events are still available.',
          'icloud_unavailable',
        );
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const target = response.headers.get('Location');
        await response.body?.cancel();
        if (!target) throw new DavError(response.status);
        url = safeUrl(target, url);
        continue;
      }
      // Bound streaming reads as well as declared lengths. Provider text is never used in errors.
      if (Number(response.headers.get('Content-Length')) > 2_000_000) {
        await response.body?.cancel();
        throw new ApiError(
          502,
          'iCloud response is too large. Saved events are unchanged.',
          'icloud_limit',
        );
      }
      const reader = response.body?.getReader();
      let size = 0;
      const decoder = new TextDecoder();
      let text = '';
      if (reader) {
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.length;
            if (size > 2_000_000) {
              await reader.cancel();
              throw new Error();
            }
            text += decoder.decode(chunk.value, { stream: true });
          }
          text += decoder.decode();
        } catch {
          throw new ApiError(
            502,
            'iCloud response could not be read. Saved events are unchanged.',
            'icloud_response',
          );
        }
      }
      if (!response.ok) {
        let invalidToken = false,
          unsupportedExpansion = false;
        if (response.status === 403) {
          try {
            const root = xml(text);
            invalidToken = !!child(root, 'valid-sync-token');
            unsupportedExpansion =
              !!child(root, 'supported-calendar-data', CAL) ||
              !!child(root, 'supported-calendar-data');
          } catch {
            /* safe generic failure */
          }
        }
        throw new DavError(response.status, invalidToken, unsupportedExpansion);
      }
      const root = xml(text);
      if (root.name !== 'multistatus' || root.ns !== DAV)
        throw new ApiError(
          502,
          'iCloud returned an incomplete calendar response.',
          'icloud_response',
        );
      return { root, url };
    }
    throw new ApiError(502, 'iCloud redirected too many times.', 'icloud_response');
  };
}
export function responses(root: Node) {
  return children(root, 'response').map((row) => {
    const href = value(row, 'href');
    if (!href) throw new ApiError(502, 'iCloud omitted a resource address.', 'icloud_response');
    const direct = value(row, 'status');
    const status = direct ? Number(direct.match(/\s(\d{3})(?:\s|$)/)?.[1]) : 200;
    if (!Number.isFinite(status))
      throw new ApiError(502, 'iCloud returned an invalid resource status.', 'icloud_response');
    const props: Node = { name: 'prop', ns: DAV, text: '', attrs: {}, children: [] };
    for (const stat of children(row, 'propstat')) {
      if (/\s200(?:\s|$)/.test(value(stat, 'status') ?? ''))
        props.children.push(...(child(stat, 'prop')?.children ?? []));
    }
    return { href, status, props };
  });
}
export const propfind = (props: string) =>
  `<d:propfind xmlns:d="DAV:" xmlns:c="${CAL}" xmlns:a="${APPLE}"><d:prop>${props}</d:prop></d:propfind>`;
export type DavClient = ReturnType<typeof client>;
export async function discovery(get: DavClient) {
  let initial;
  try {
    initial = await get(
      'https://caldav.icloud.com/.well-known/caldav',
      'PROPFIND',
      propfind('<d:current-user-principal/>'),
    );
  } catch (e) {
    if (!(e instanceof DavError) || ![404, 405].includes(e.davStatus)) throw e;
    initial = await get(
      'https://caldav.icloud.com/',
      'PROPFIND',
      propfind('<d:current-user-principal/>'),
    );
  }
  const principal = responses(initial.root)
    .map((r) => child(child(r.props, 'current-user-principal') ?? r.props, 'href')?.text.trim())
    .find(Boolean);
  if (!principal) throw new ApiError(502, 'iCloud principal discovery failed.', 'icloud_discovery');
  const principalUrl = safeUrl(principal, initial.url);
  const result = await get(principalUrl, 'PROPFIND', propfind('<c:calendar-home-set/>'));
  const home = responses(result.root)
    .map((r) => child(child(r.props, 'calendar-home-set', CAL) ?? r.props, 'href')?.text.trim())
    .find(Boolean);
  if (!home) throw new ApiError(502, 'iCloud calendar home discovery failed.', 'icloud_discovery');
  const homeUrl = safeUrl(home, result.url);
  return { principalUrl, homeUrl, calendars: await listCalendars(get, homeUrl) };
}
export async function listCalendars(get: DavClient, home: string) {
  const { root, url } = await get(
    home,
    'PROPFIND',
    propfind(
      '<d:resourcetype/><d:displayname/><a:calendar-color/><c:supported-calendar-component-set/><d:supported-report-set/>',
    ),
    '1',
  );
  const rows = responses(root);
  if (!rows.length || rows.some((r) => r.status !== 200 || !child(r.props, 'resourcetype')))
    throw new ApiError(
      502,
      'iCloud calendar discovery was incomplete. Existing settings are unchanged.',
      'icloud_discovery',
    );
  const calendars = rows
    .filter((r) => !!child(child(r.props, 'resourcetype') ?? r.props, 'calendar', CAL))
    .filter((r) => {
      const set = child(r.props, 'supported-calendar-component-set', CAL);
      return !set || children(set, 'comp', CAL).some((c) => c.attrs.name === 'VEVENT');
    })
    .map((r) => {
      const color = value(r.props, 'calendar-color', APPLE)?.slice(0, 7);
      const reports = child(r.props, 'supported-report-set');
      return {
        url: safeUrl(r.href, url).replace(/\/?$/, '/'),
        name: value(r.props, 'displayname')?.slice(0, 120) || 'iCloud calendar',
        color: /^#[\da-f]{6}$/i.test(color ?? '') ? color! : '#748bc0',
        supportsSync:
          !!reports &&
          children(reports, 'supported-report').some(
            (n) => !!child(child(n, 'report') ?? n, 'sync-collection'),
          ),
      };
    });
  if (calendars.length > 40 || new Set(calendars.map((c) => c.url)).size !== calendars.length)
    throw new ApiError(502, 'iCloud returned too many or duplicate calendars.', 'icloud_limit');
  return calendars;
}
