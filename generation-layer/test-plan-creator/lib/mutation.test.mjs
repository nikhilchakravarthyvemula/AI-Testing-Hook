import test from 'node:test';
import assert from 'node:assert/strict';

import { isMutation, endpointMethod } from './mutation.mjs';

test('endpointMethod parses the leading HTTP verb, else null', () => {
  assert.equal(endpointMethod('POST /api/v2/orders'), 'POST');
  assert.equal(endpointMethod('get /cart'), 'GET');
  assert.equal(endpointMethod('/cart'), null);        // no method
  assert.equal(endpointMethod(''), null);
});

test('a read-only GET endpoint with neutral text is not a mutation', () => {
  assert.equal(isMutation({
    title: 'cart contents load', intent: 'fetch the cart and assert shape',
    targets: { endpoints: ['GET /api/v2/cart'] },
  }), false);
});

test('any non-read method flags mutation, regardless of text', () => {
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal(isMutation({
      title: 'x', intent: 'y', targets: { endpoints: [`${m} /api/v2/orders`] },
    }), true, `${m} should be a mutation`);
  }
});

test('the mutation lexicon flags a GET-only scenario whose intent writes', () => {
  assert.equal(isMutation({
    title: 'submit the checkout form', intent: 'complete a purchase',
    targets: { pages: ['/checkout'] },
  }), true);
});

test('an unparseable endpoint target is uncertain ⇒ fail-safe mutation', () => {
  assert.equal(isMutation({
    title: 'x', intent: 'y', targets: { endpoints: ['/api/v2/cart'] },  // no method
  }), true);
});

test('a page-only load with neutral text is safe', () => {
  assert.equal(isMutation({
    title: 'home page renders', intent: 'load the landing page',
    targets: { pages: ['/'] },
  }), false);
});
