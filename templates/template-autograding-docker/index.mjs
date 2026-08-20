/**
 * PXL Classroom - Docker Group Microservice Template
 */

export function parsePayload(jsonString) {
  if (!jsonString || typeof jsonString !== 'string') {
    throw new Error('Invalid input payload');
  }
  const parsed = JSON.parse(jsonString);
  if (!parsed.event_id || !parsed.data) {
    throw new Error('Missing required fields: event_id, data');
  }
  return {
    processed: true,
    event_id: parsed.event_id,
    item_count: Array.isArray(parsed.data) ? parsed.data.length : 1,
    timestamp: new Date().toISOString(),
  };
}

export function computeMetrics(items) {
  if (!Array.isArray(items)) return { total: 0, min: null, max: null };
  if (items.length === 0) return { total: 0, min: null, max: null };

  const nums = items.filter(x => typeof x === 'number');
  if (nums.length === 0) return { total: 0, min: null, max: null };

  return {
    total: nums.reduce((a, b) => a + b, 0),
    min: Math.min(...nums),
    max: Math.max(...nums),
  };
}
