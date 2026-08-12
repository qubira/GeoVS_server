// Resuelve pais/codigo de pais a partir de una IP publica, usando la API
// gratuita ip-api.com (sin API key, ~45 req/min desde la IP del servidor).
// Se cachea por IP para no repetir la consulta en reconexiones del mismo
// jugador. IPs privadas/locales (desarrollo) devuelven null sin consultar.
const cache = new Map(); // ip -> { country, countryCode }
const UNKNOWN = { country: null, countryCode: null };
const LOOKUP_TIMEOUT_MS = 3000;

function isPrivateIp(ip) {
  if (!ip) return true;
  if (ip === '::1' || ip === '127.0.0.1') return true;
  if (ip.startsWith('::ffff:127.')) return true;
  if (/^10\./.test(ip)) return true;
  if (/^192\.168\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return true;
  return false;
}

export async function lookupCountry(rawIp) {
  const ip = String(rawIp || '').replace(/^::ffff:/, '');
  if (isPrivateIp(ip)) return UNKNOWN;
  if (cache.has(ip)) return cache.get(ip);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
    const res = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,countryCode`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    const data = await res.json();
    const result =
      data.status === 'success' ? { country: data.country, countryCode: data.countryCode } : UNKNOWN;
    cache.set(ip, result);
    return result;
  } catch {
    return UNKNOWN;
  }
}

// Resuelve la IP publica real del cliente a partir del handshake de
// socket.io, respetando x-forwarded-for (necesario detras del proxy de
// Render/Vercel/etc).
export function clientIpFromSocket(socket) {
  const forwarded = socket.handshake.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return socket.handshake.address;
}
