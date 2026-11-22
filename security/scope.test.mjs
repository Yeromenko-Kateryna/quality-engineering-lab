import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { authorize, createGuard, maxRequests, origin, readResponse, states } from './scope.mjs';
import { validateAudit, validateZap } from './evidence.mjs';

test('authorize exact parsed origin, path and query before any network activity', () => {
  for (const route of Object.keys(states)) assert.equal(authorize(origin + route), route);
  for (const value of [
    'http://outside.invalid:3000/', 'https://sut:3000/', 'http://sut:3001/', 'http://sut/',
    'http://user:pass@sut:3000/', 'http://127.0.0.1:3000/', 'http://[::1]:3000/', 'http://[invalid/',
    'http://sut:3000/api/items', 'http://sut:3000/search?extra=1', 'http://sut:3000/search?q=notebook&q=compass',
    'http://sut:3000/#fragment', 'http://SUT:3000/', 'http://sut:3000/./search',
  ]) {
    assert.throws(() => authorize(value), undefined, value);
    console.log(JSON.stringify({ layer: 'parser', rejected: value }));
  }
});

test('real HTTP guard blocks unapproved discovered links, redirects, methods and excess requests', async t => {
  const events = [];
  const received = [];
  const destinations = [];
  const link = '/api/items';
  const listen = async server => {
    t.after(() => new Promise(resolve => server.close(resolve)));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { hostname: '127.0.0.1', port: server.address().port };
  };
  const outside = await listen(createServer((req, res) => { destinations.push(req.url); res.end('controlled'); }));
  const location = `http://127.0.0.1:${outside.port}/elsewhere`;
  const upstream = await listen(createServer((req, res) => {
    received.push(req.url);
    if (req.url === '/search') res.writeHead(302, { location }).end();
    else res.end(`<a href="${link}">outside path</a><a href="${location}">outside origin</a>`);
  }));
  const guard = await listen(createGuard(upstream, event => events.push(event)));
  const send = (path, method = 'GET') => readResponse({ ...guard, path, method, headers: { host: 'sut:3000' } });

  assert.equal((await readResponse({ ...outside, path: '/elsewhere' })).body.toString(), 'controlled');
  const html = (await send('/')).body.toString();
  assert.ok(html.includes(link) && html.includes(location), 'approved HTML exposes the fixture links');
  assert.equal((await send(link)).status, 403);
  assert.equal((await send(location)).status, 403);
  assert.equal((await send('/', 'POST')).status, 403);
  const redirect = await send('/search');
  assert.equal(redirect.status, 502);
  assert.equal(redirect.headers.location, undefined);
  assert.deepEqual(received, ['/', '/search']);
  assert.deepEqual(destinations, ['/elsewhere'], 'only the independent positive control reached the live listener');

  for (let count = received.length; count < maxRequests; count++) assert.equal((await send('/')).status, 200);
  assert.equal((await send('/')).status, 429);
  assert.equal(received.length, maxRequests);
  console.log(JSON.stringify({
    layer: 'loopback HTTP guard', discoveredPath: link, discoveredOrigin: location, receivedByOutside: destinations,
    denied: events.filter(event => event.reason !== 'response'), forwarded: received.length,
  }));
});

test('tool error evidence cannot become a clean decision', () => {
  assert.throws(() => validateZap({}, 3, '', ''));
  assert.throws(() => validateAudit({ error: { code: 'EAI_AGAIN' } }, 1));
});
