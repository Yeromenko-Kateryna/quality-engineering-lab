import Fastify, { type FastifyReply } from 'fastify';
import { setTimeout as delay } from 'node:timers/promises';

const items = Object.freeze([
  Object.freeze({ id: 'field-notebook', name: 'Field Notebook' }),
  Object.freeze({ id: 'desk-notebook', name: 'Desk Notebook' }),
  Object.freeze({ id: 'brass-ruler', name: 'Brass Ruler' }),
]);

const csp = "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const invalidQuery = 'Enter a single search term of 1 to 80 characters.';
const maxDelayMs = 2_000;

function booleanSetting(name: string): boolean {
  const value = process.env[name];
  if (value === undefined || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error(`${name} must be true or false`);
}

function readConfig() {
  const value = process.env.LAB_DELAY_MS ?? '0';
  const delayMs = Number(value);
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > maxDelayMs || String(delayMs) !== value) {
    throw new Error(`LAB_DELAY_MS must be a whole decimal number from 0 to ${maxDelayMs}`);
  }
  return {
    delayMs,
    a11yDefect: booleanSetting('LAB_A11Y_DEFECT'),
    securityDefect: booleanSetting('LAB_SECURITY_DEFECT'),
  };
}

function search(value: unknown) {
  if (typeof value !== 'string') return undefined;
  const query = value.trim();
  if (query.length === 0 || query.length > 80) return undefined;
  const term = query.toLowerCase();
  return { items: items.filter(item => item.name.toLowerCase().includes(term)) };
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function itemList(results: typeof items): string {
  return `<ul>${results.map(item => `<li>${escapeHtml(item.name)}</li>`).join('')}</ul>`;
}

export function buildApp() {
  const config = readConfig();
  const app = Fastify();

  app.addHook('onRequest', async (_request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
  });

  function html(reply: FastifyReply, title: string, content: string) {
    if (!config.securityDefect) reply.header('Content-Security-Policy', csp);
    return reply.type('text/html; charset=utf-8').send(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head>
<body>
<nav><a href="/">Catalogue</a> <a href="/search">Search</a></nav>
<main><h1>${title}</h1>${content}</main>
</body>
</html>`);
  }

  app.get('/health', () => ({ status: 'ready' }));
  app.get('/api/items', () => ({ items }));
  app.get<{ Querystring: { q?: unknown } }>('/api/search', async (request, reply) => {
    if (config.delayMs > 0) await delay(config.delayMs);
    return search(request.query.q) ?? reply.code(400).send({ error: invalidQuery });
  });

  app.get('/', (_request, reply) => html(reply, 'Catalogue', itemList(items)));
  app.get<{ Querystring: { q?: unknown } }>('/search', (request, reply) => {
    const value = request.query.q;
    let feedback = '';
    if (value !== undefined) {
      const result = search(value);
      if (!result) {
        reply.code(400);
        feedback = `<p>${invalidQuery}</p>`;
      } else {
        feedback = result.items.length > 0 ? itemList(result.items) : '<p>No items found.</p>';
      }
    }

    const label = config.a11yDefect ? '' : '<label for="search-term">Search catalogue</label>';
    const inputValue = typeof value === 'string' ? escapeHtml(value) : '';
    return html(reply, 'Search', `
<form method="get" action="/search">
  ${label}
  <input type="search" id="search-term" name="q" value="${inputValue}">
  <button type="submit">Search</button>
</form>
${feedback}`);
  });

  return app;
}
