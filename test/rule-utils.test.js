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

function snapshot(overrides) {
    return Object.assign({
        expiresAt: 2000,
        priorRules: ['@@||example.com^$important', '||ads.example^'],
        appliedRules: ['||ads.example^'],
        cancelledPending: null,
    }, overrides || {});
}

test('planUndo restores prior rules when current rules match', () => {
    assert.deepEqual(
        R.planUndo(snapshot(), ['||ads.example^'], 1000),
        { ok: true, rules: ['@@||example.com^$important', '||ads.example^'], restorePending: null }
    );
});

test('planUndo ignores rule order when comparing', () => {
    const result = R.planUndo(
        snapshot({ appliedRules: ['a', 'b'] }),
        ['b', 'a'],
        1000
    );
    assert.equal(result.ok, true);
});

test('planUndo refuses expired or changed snapshots', () => {
    assert.deepEqual(R.planUndo(snapshot(), ['||ads.example^'], 2000), { ok: false, reason: 'expired' });
    assert.deepEqual(R.planUndo(snapshot(), ['other'], 1000), { ok: false, reason: 'changed' });
    assert.deepEqual(R.planUndo(null, [], 1000), { ok: false, reason: 'missing' });
});

test('planUndo restores a cancelled temporary unblock that is still pending', () => {
    const pending = { rule: '@@||doubleclick.net^$important', until: 5000 };
    const result = R.planUndo(
        snapshot({ cancelledPending: pending }),
        ['||ads.example^'],
        1000
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.restorePending, pending);
});

test('planUndo drops the allow rule when its pending deadline passed', () => {
    const pending = { rule: '@@||doubleclick.net^$important', until: 500 };
    const result = R.planUndo(
        snapshot({
            priorRules: ['@@||doubleclick.net^$important'],
            appliedRules: ['||doubleclick.net^$important'],
            cancelledPending: pending,
        }),
        ['||doubleclick.net^$important'],
        1000
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.rules, []);
    assert.equal(result.restorePending, null);
});
