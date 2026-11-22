import { check } from 'k6';
import http from 'k6/http';
import { Counter } from 'k6/metrics';

const query = __ENV.QEL_QUERY ?? 'notebook';
if (query !== 'notebook' && query !== 'compass') {
  throw new Error('QEL_QUERY must be notebook or compass');
}

const url = `http://sut:3000/api/search?q=${query}`;
const queryRequests = new Counter(`search_smoke_${query}_requests`);
const emptyResults = new Counter('search_smoke_empty_items');

export const options = {
  scenarios: {
    search_smoke: {
      executor: 'constant-vus',
      vus: 1,
      duration: '10s',
      gracefulStop: '3s',
    },
  },
  minIterationDuration: '1s',
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
  },
};

http.setResponseCallback(http.expectedStatuses(200));

export default function () {
  const response = http.get(url, { redirects: 0, timeout: '2s' });
  let json;
  let parsed = false;
  try {
    if (typeof response.body === 'string') {
      json = JSON.parse(response.body);
      parsed = true;
    }
  } catch {
    // Let the mandatory checks record a malformed response.
  }

  const items = json?.items;
  const hasItems = Array.isArray(items);
  const mediaType = (response.headers['Content-Type'] ?? '').split(';')[0].trim().toLowerCase();
  queryRequests.add(1);
  emptyResults.add(hasItems && items.length === 0 ? 1 : 0);

  check(response, {
    http_response_received: r => r.status > 0,
    status_is_200: r => r.status === 200,
    content_type_is_json: () => mediaType === 'application/json',
    body_is_valid_json: () => parsed,
    items_is_array: () => hasItems,
    contains_field_notebook: () => hasItems && items.some(item => item?.id === 'field-notebook'),
    contains_desk_notebook: () => hasItems && items.some(item => item?.id === 'desk-notebook'),
  });
}
