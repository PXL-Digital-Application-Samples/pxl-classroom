import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePayload, computeMetrics } from '../index.mjs';

test('Integration: End-to-end payload extraction and metrics pipeline', () => {
  const payload = JSON.stringify({
    event_id: 'evt-pipeline-99',
    data: [42, 108, 15, 23, 4],
  });

  const parsed = parsePayload(payload);
  assert.equal(parsed.processed, true);

  const metrics = computeMetrics([42, 108, 15, 23, 4]);
  assert.equal(metrics.total, 192);
  assert.equal(metrics.min, 4);
  assert.equal(metrics.max, 108);
});
