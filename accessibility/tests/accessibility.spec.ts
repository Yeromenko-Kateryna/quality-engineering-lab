import { writeFile } from 'node:fs/promises';
import { expect, test as base, type Page, type Response } from '@playwright/test';
import axe from 'axe-core';

const origin = 'http://sut:3000';
const states = [
  { name: 'catalogue', route: '/', status: 200, heading: 'Catalogue', feedback: 'Brass Ruler' },
  { name: 'search', route: '/search', status: 200, heading: 'Search' },
  { name: 'matching', route: '/search?q=notebook', status: 200, heading: 'Search', feedback: 'Field Notebook' },
  { name: 'empty', route: '/search?q=compass', status: 200, heading: 'Search', feedback: 'No items found.' },
  { name: 'invalid', route: '/search?q=', status: 400, heading: 'Search', feedback: 'Enter a single search term of 1 to 80 characters.' },
] as const;
const allowed = new Set(states.map(state => origin + state.route));

const test = base.extend({
  page: async ({ page, context }, use) => {
    const session = await context.newCDPSession(page);
    const errors: unknown[] = [];
    session.on('Fetch.requestPaused', async ({ requestId, request, redirectedRequestId }) => {
      try {
        if (request.method === 'GET' && allowed.has(request.url) && !redirectedRequestId) {
          await session.send('Fetch.continueRequest', { requestId });
        } else {
          await session.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
        }
      } catch (error) {
        errors.push(error);
      }
    });
    await session.send('Fetch.enable');
    await use(page);
    if (errors.length) throw new Error('Browser request interception failed', { cause: errors[0] });
  },
});

function requireDocument(response: Response | null, route: string, status: number) {
  if (response?.url() !== origin + route || response.status() !== status) {
    throw new Error(`Expected ${route} HTTP ${status}, received ${response?.url()} HTTP ${response?.status()}`);
  }
  return response;
}

async function save(name: string, data: unknown) {
  await writeFile(`/reports/${name}.json`, JSON.stringify(data, null, 2));
}

for (const state of states) {
  test(state.name, async ({ page, browser }) => {
    const response = requireDocument(await page.goto(state.route), state.route, state.status);
    const input = page.getByRole('searchbox');

    // Playwright evaluates the bundled axe source in the document through Chromium.
    await page.evaluate(axe.source);
    const findings = await page.evaluate(() =>
      (window as Window & { axe: typeof axe }).axe.run(document),
    );
    if (findings.testEngine.version !== axe.version || findings.url !== response.url() ||
        findings.passes.length === 0 || !Array.isArray(findings.violations)) {
      throw new Error('axe did not produce a complete result for the expected document');
    }
    await save(`axe-${state.name}`, findings);
    await save(`state-${state.name}`, {
      url: response.url(),
      status: response.status(),
      csp: await response.headerValue('content-security-policy'),
      browser: browser.version(),
      node: process.version,
      ...(state.name === 'search' && { input: await input.ariaSnapshot() }),
    });

    const blocking = findings.violations.filter(rule => rule.impact === 'critical' || rule.impact === 'serious');
    await expect.soft(blocking.map(rule => ({
      id: rule.id, impact: rule.impact, nodes: rule.nodes.map(node => node.target),
    })), 'A11Y: no serious or critical axe findings').toEqual([]);
    await expect(page.getByRole('heading', { level: 1, name: state.heading }), 'A11Y: visible page heading').toBeVisible();
    if ('feedback' in state) {
      await expect(page.getByText(state.feedback, { exact: true }), 'A11Y: visible page feedback').toBeVisible();
    }
    if (state.name === 'matching') {
      await expect(page.getByText('Desk Notebook', { exact: true }), 'A11Y: second notebook result is visible').toBeVisible();
    }
    if (state.name === 'search') {
      await expect(page.locator('form').getByRole('button', { name: 'Search' }), 'A11Y: visible submit control').toBeVisible();
      await expect(input, 'A11Y: search input accessible name').toHaveAccessibleName('Search catalogue');
    }
  });
}

function focus(page: Page) {
  return page.evaluate(() => {
    const active = document.activeElement;
    if (!active) throw new Error('Document has no active element');
    const style = getComputedStyle(active);
    return {
      element: active.tagName,
      id: active.id,
      text: active.textContent?.trim().slice(0, 80),
      focusVisible: active.matches(':focus-visible'),
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth),
    };
  });
}

test('keyboard search', async ({ page }) => {
  requireDocument(await page.goto('/search'), '/search', 200);
  const stops = [];
  for (const [tag, text] of [['A', 'Catalogue'], ['A', 'Search'], ['INPUT', ''], ['BUTTON', 'Search']]) {
    await page.keyboard.press('Tab');
    const stop = await focus(page);
    stops.push(stop);
    expect([stop.element, stop.text], 'A11Y: keyboard tab progression').toEqual([tag, text]);
    if (tag === 'INPUT') {
      expect(stop.id, 'A11Y: keyboard reaches the search field').toBe('search-term');
      await page.keyboard.type('notebook');
    }
    expect(stop.focusVisible && stop.outlineStyle !== 'none' && stop.outlineWidth > 0,
      'A11Y: visible keyboard focus outline').toBe(true);
  }

  const [response] = await Promise.all([
    page.waitForResponse(result => result.request().isNavigationRequest() && result.url() === origin + '/search?q=notebook',
      { timeout: 5_000 }),
    page.keyboard.press('Enter'),
  ]);
  requireDocument(response, '/search?q=notebook', 200);
  await expect(page.getByRole('main').getByRole('listitem'), 'A11Y: keyboard submission shows both notebooks')
    .toHaveText(['Field Notebook', 'Desk Notebook']);
  const afterNavigation = await focus(page);
  await page.keyboard.press('Tab');
  const nextTab = await focus(page);
  await save('keyboard', { url: response.url(), status: response.status(), stops, afterNavigation, nextTab });
  expect(nextTab.focusVisible && nextTab.outlineStyle !== 'none' && nextTab.outlineWidth > 0,
    'A11Y: visible focus after tabbing in the results document').toBe(true);
});
