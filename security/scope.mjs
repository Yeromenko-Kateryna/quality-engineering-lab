import { createServer, request } from 'node:http';
import { createHash } from 'node:crypto';
import { connect, isIPv4 } from 'node:net';
import { pathToFileURL } from 'node:url';

export const origin = 'http://sut:3000';
export const states = Object.freeze({
  '/': 200,
  '/search': 200,
  '/search?q=notebook': 200,
  '/search?q=compass': 200,
  '/search?q=': 400,
});
export const responseStatuses = Object.freeze({
  ...states,
  '/health': 200,
  '/api/items': 200,
  '/api/search?q=notebook': 200,
});
export const csp = "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
export const maxRequests = 32;

export function matchesResponse(route, { status, contentType, policies, xContentTypeOptions }) {
  const html = Object.hasOwn(states, route);
  const expectedType = html ? 'text/html' : 'application/json';
  return status === responseStatuses[route] && contentType?.split(';')[0].trim().toLowerCase() === expectedType &&
    xContentTypeOptions.length === 1 && xContentTypeOptions[0] === 'nosniff' &&
    (!html || (policies.length === 1 && policies[0] === csp));
}

export function authorize(target) {
  const url = new URL(target);
  const route = url.pathname + url.search;
  if (url.protocol !== 'http:' || url.hostname !== 'sut' || url.port !== '3000' ||
      url.username || url.password || url.hash || target !== origin + route ||
      !Object.hasOwn(states, route)) {
    throw new Error('Target is outside the fixed QEL-4 scope');
  }
  return route;
}

export function readResponse(options) {
  return new Promise((resolve, reject) => {
    const req = request({ agent: false, signal: AbortSignal.timeout(2500), ...options }, response => {
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 64 * 1024) {
          response.destroy(new Error('Response exceeded the lab size limit'));
        } else {
          chunks.push(chunk);
        }
      });
      response.on('error', reject);
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headersDistinct,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

export function createGuard(upstream, observe) {
  let accepted = 0;
  return createServer(async (req, res) => {
    const event = { method: req.method, path: req.url, forwarded: false };
    const deny = (status, reason) => {
      observe({ ...event, status, reason });
      res.writeHead(status).end();
    };
    try {
      if (req.method !== 'GET' || req.headers.host !== 'sut:3000' ||
          req.headers['transfer-encoding'] || (req.headers['content-length'] ?? '0') !== '0') {
        throw new Error('Unsupported request');
      }
      authorize(origin + req.url);
    } catch {
      return deny(403, 'scope');
    }
    if (accepted >= maxRequests) return deny(429, 'budget');
    accepted++;
    event.forwarded = true;

    try {
      const { status, headers, body } = await readResponse({
        ...upstream, path: req.url, headers: { host: 'sut:3000' },
      });
      if (status >= 300 && status < 400) {
        const destination = headers.location?.[0] ?? null;
        observe({ ...event, status: 502, upstreamStatus: status, reason: 'redirect', destination });
        return res.writeHead(502).end();
      }
      // Forward the small HTML response and its end-to-end headers.
      const hopHeaders = ['connection', 'keep-alive', 'transfer-encoding', 'trailer', 'upgrade'];
      const forwardedHeaders = Object.fromEntries(Object.entries(headers).filter(([name]) => !hopHeaders.includes(name)));
      observe({ ...event, status, reason: 'response' });
      res.writeHead(status, forwardedHeaders).end(body);
    } catch {
      deny(502, 'upstream-error');
    }
  });
}

async function checkCsp() {
  const observations = [];
  for (const route of Object.keys(responseStatuses)) {
    const url = origin + route;
    try {
      const { status, headers, body } = await readResponse({ hostname: 'sut', port: 3000, path: route });
      const observation = {
        url, status,
        contentType: headers['content-type']?.[0] ?? null,
        policies: headers['content-security-policy'] ?? [],
        xContentTypeOptions: headers['x-content-type-options'] ?? [],
        bodySha256: createHash('sha256').update(body).digest('hex'),
      };
      observations.push({ ...observation, passed: matchesResponse(route, observation) });
    } catch (error) {
      observations.push({ url, error: error.message });
    }
  }
  const outcome = observations.some(row => row.error) ? 'TOOL_ERROR' :
    observations.every(row => row.passed) ? 'PASS' : 'FAIL';
  print({ policy: 'SEC-G01', csp, outcome, observations });
  process.exitCode = { PASS: 0, FAIL: 1, TOOL_ERROR: 2 }[outcome];
}

function print(value) {
  console.log(JSON.stringify(value));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , mode, input] = process.argv;
  try {
    if (mode === 'preflight') {
      print({ target: origin + '/', route: authorize(origin + '/') });
    } else if (mode === 'csp') {
      await checkCsp();
    } else if (mode === 'guard') {
      if (!isIPv4(input) || !/^(?:10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.)/.test(input)) {
        throw new Error('Expected the owned SUT bridge IPv4');
      }
      createGuard({ hostname: input, port: 3000 }, print).listen(3000, '0.0.0.0');
    } else if (mode === 'connect') {
      if (!isIPv4(input)) throw new Error('Expected an owned bridge IPv4');
      const socket = connect({ host: input, port: 3000, timeout: 1500 });
      socket.once('connect', () => { print({ destination: input, connected: true }); socket.destroy(); });
      socket.once('timeout', () => socket.destroy(Object.assign(new Error('Connection timed out'), { code: 'ETIMEDOUT' })));
      socket.once('error', error => { print({ destination: input, connected: false, code: error.code }); process.exitCode = 1; });
    } else {
      throw new Error('Unknown QEL-4 scope command');
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
