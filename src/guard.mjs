// Bewaking van adressen (SSRF), volgens de OWASP SSRF Prevention Cheat Sheet:
// alleen https, alleen hosts uit de lijst van rapportage, en de host moet naar openbare IP-adressen wijzen.
// Daarnaast blokkeert de firewall op de server alle interne adressen (deploy/firewall.sh), zodat ook
// subbronnen en DNS-trucs niet bij interne netwerken komen.
import dns from 'node:dns/promises';
import net from 'node:net';

const V4_BLOCKED = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];

function v4ToInt(ip) {
  return ip.split('.').reduce((a, o) => ((a << 8) + Number(o)) >>> 0, 0);
}

export function isPublicIp(ip) {
  if (net.isIPv4(ip)) {
    const n = v4ToInt(ip);
    return !V4_BLOCKED.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (n & mask) === (v4ToInt(base) & mask);
    });
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    if (x === '::' || x === '::1') return false;
    const mapped = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicIp(mapped[1]);
    if (/^(fc|fd)/.test(x)) return false; // unique local
    if (/^fe[89ab]/.test(x)) return false; // link-local
    if (/^ff/.test(x)) return false; // multicast
    if (/^(2001:db8|2001:0db8)/.test(x)) return false; // documentatie
    if (/^64:ff9b/.test(x)) return false; // NAT64
    return true;
  }
  return false;
}

/** Normaliseert en controleert een adres. Geeft {url, host} of gooit een fout met een Nederlandse melding. */
export function checkUrl(raw, allowedHosts, { allowHttp = false } = {}) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    throw new GuardError('ongeldig_adres', 'Dit is geen geldig adres.');
  }
  if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) {
    throw new GuardError('geen_https', 'Alleen https-adressen worden gemeten.');
  }
  if (u.username || u.password) {
    throw new GuardError('ongeldig_adres', 'Adressen met inloggegevens worden niet gemeten.');
  }
  if (u.port && !allowHttp) {
    throw new GuardError('ongeldig_adres', 'Adressen met een poortnummer worden niet gemeten.');
  }
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (net.isIP(host.replace(/^\[|\]$/g, '')) && !allowHttp) {
    throw new GuardError('ongeldig_adres', 'Alleen domeinnamen, geen IP-adressen.');
  }
  const allowed = (allowedHosts || []).map((h) => String(h).toLowerCase().replace(/\.$/, ''));
  if (!allowed.includes(host)) {
    throw new GuardError('ander_domein', `Dit adres hoort niet bij de gekoppelde site (${host}).`);
  }
  u.hash = '';
  return { url: u.toString(), host };
}

/** Zoekt de host op; alle adressen moeten openbaar zijn. Geeft het eerste adres terug (wordt vastgezet in de browser). */
export async function resolvePublic(host, { allowPrivate = false } = {}) {
  let addrs;
  try {
    addrs = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new GuardError('niet_gevonden', `Het domein ${host} bestaat niet of is niet bereikbaar.`);
  }
  if (!addrs.length) throw new GuardError('niet_gevonden', `Het domein ${host} heeft geen adres.`);
  if (!allowPrivate && addrs.some((a) => !isPublicIp(a.address))) {
    throw new GuardError('intern_adres', `Het domein ${host} wijst naar een intern adres; dat wordt niet gemeten.`);
  }
  const v4 = addrs.find((a) => a.family === 4);
  return (v4 || addrs[0]).address;
}

export class GuardError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
