import assert from 'node:assert/strict';
import { hasClosingTime } from './native-trial-checks.mjs';
for (const text of ['오후 7:00', '오후 7시', '19:00', '19시', '오후 일곱 시']) assert.equal(hasClosingTime(text, 19), true, text);
for (const text of ['오후 6:00', '오전 7:00', '7시', '주문 19개', '']) assert.equal(hasClosingTime(text, 19), false, text);
assert.equal(hasClosingTime('오전 10:00 ~ 오후 6:00', 18), true);
console.log('PASS native closing-time positive and negative controls');
