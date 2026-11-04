'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/list-utils.js');

test('filterRules matches case-insensitive substrings', () => {
    const rules = ['example.com##.ad', 'example.org##.banner', 'test.com#@#.ad'];
    assert.deepEqual(L.filterRules(rules, 'BANNER'), ['example.org##.banner']);
    assert.deepEqual(L.filterRules(rules, 'example'), [rules[0], rules[1]]);
});

test('filterRules returns all rules for an empty query', () => {
    assert.deepEqual(L.filterRules(['a', 'b'], '   '), ['a', 'b']);
});

test('filterRules treats regex characters literally and tolerates bad input', () => {
    assert.deepEqual(L.filterRules(['a.b##x', 'ab##x'], 'a.b'), ['a.b##x']);
    assert.deepEqual(L.filterRules(null, 'x'), []);
});
