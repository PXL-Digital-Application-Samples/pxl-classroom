import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePayload, computeMetrics } from '../index.mjs';

test('Unit: parsePayload correctly parses valid events', () => {
  const result = parsePayload(JSON.stringify({ event_id: 'evt-101', data: [1, 2, 3] }));
  assert.equal(result.processed, true);
  assert.equal(result.event_id, 'evt-101');
  assert.equal(result.item_count, 3);
});

test('Unit: computeMetrics aggregates numbers correctly', () => {
  const metrics = computeMetrics([10, 20, 5, 100]);
  assert.equal(metrics.total, 135);
  assert.equal(metrics.min, 5);
  assert.equal(metrics.max, 100);
});
