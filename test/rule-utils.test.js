'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../src/rule-utils.js');

test('global unblock adds the parent allow rule and removes block rules', () => {
    const rules = R.toggleRules('chunks.example.com', 'example.com', false, '', 'unblock');
    assert.equal(rules.addRule, '@@||example.com^$important');
    assert.deepEqual(rules.removeRules, ['||example.com^$important', '||chunks.example.com^$important']);
});

test('client-only rules escape quotes and commas', () => {
    const rules = R.toggleRules("a'b,c", "a'b,c", true, "a'b,c", 'unblock');
    assert.equal(rules.addRule, "@@||a'b,c^$client='a\\'b\\,c'");
    assert.equal(rules.hostAllowRule, "@@||a'b,c^$client='a\\'b\\,c'");
});

test('block targets the current host and removes its allow rule', () => {
    const rules = R.toggleRules('chunks.example.com', 'example.com', false, '', 'block');
    assert.equal(rules.addRule, '||chunks.example.com^$important');
    assert.deepEqual(rules.removeRules, ['@@||chunks.example.com^$important']);
});

test('duration labels are human readable', () => {
    assert.equal(R.durationLabel(30000), '30 seconds');
    assert.equal(R.durationLabel(60000), '1 minute');
    assert.equal(R.durationLabel(300000), '5 minutes');
    assert.equal(R.durationLabel(3600000), '1 hour');
});
