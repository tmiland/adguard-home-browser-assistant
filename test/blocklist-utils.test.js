'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('../src/blocklist-utils.js');

function catalog(overrides) {
    return Object.assign({
        schema: 1,
        lists: [
            {
                id: 'alpha',
                name: 'Alpha List',
                description: 'Ads and trackers',
                maintainer: 'Alpha',
                topics: ['ads', 'trackers'],
                url: 'https://example.com/alpha.txt',
                health: { status: 'ok', entries: 10, rules: 12 },
            },
            {
                id: 'beta',
                name: 'Beta List',
                description: 'Malware domains',
                maintainer: 'Beta',
                topics: ['malware'],
                url: 'https://example.com/beta.txt',
                health: { status: 'warn', entries: 20, rules: 21 },
            },
            {
                id: 'gamma',
                name: 'Gamma Regional',
                description: 'Regional ads',
                maintainer: 'Gamma',
                topics: ['regional'],
                url: 'https://example.com/gamma.txt',
                health: null,
            },
        ],
        packs: [
            { id: 'starter', name: 'Starter', lists: ['alpha', 'beta'] },
            { id: 'regional', name: 'Regional', lists: ['gamma'] },
        ],
    }, overrides || {});
}

test('validateCatalog accepts schema 1 and resolves packs', () => {
    const result = B.validateCatalog(catalog());
    assert.equal(result.ok, true);
    assert.equal(result.catalog.lists.length, 3);
});

test('validateCatalog rejects bad schema, duplicate ids, bad URLs and missing pack members', () => {
    assert.equal(B.validateCatalog(catalog({ schema: 2 })).ok, false);
    const duplicate = catalog();
    duplicate.lists[1].id = 'alpha';
    assert.equal(B.validateCatalog(duplicate).ok, false);
    const badUrl = catalog();
    badUrl.lists[0].url = 'javascript:alert(1)';
    assert.equal(B.validateCatalog(badUrl).ok, false);
    const missing = catalog();
    missing.packs[0].lists.push('nope');
    assert.equal(B.validateCatalog(missing).ok, false);
    assert.equal(B.validateCatalog(null).ok, false);
});

test('resolveSelection merges packs and lists without duplicates', () => {
    const data = catalog();
    assert.deepEqual(
        B.resolveSelection(data, ['starter'], ['gamma', 'alpha']).map((list) => list.id),
        ['alpha', 'beta', 'gamma']
    );
    assert.deepEqual(B.resolveSelection(data, ['missing'], []), []);
});

test('partitionImport skips URLs already in AdGuard Home', () => {
    const lists = catalog().lists;
    const result = B.partitionImport(lists, ['https://example.com/beta.txt']);
    assert.deepEqual(result.toAdd.map((list) => list.id), ['alpha', 'gamma']);
    assert.deepEqual(result.skipped.map((list) => list.id), ['beta']);
});

test('partitionImport dedupes repeated URLs in one selection', () => {
    const lists = [
        { id: 'first', url: 'https://example.com/same.txt' },
        { id: 'second', url: 'https://example.com/same.txt' },
    ];
    const result = B.partitionImport(lists, []);
    assert.deepEqual(result.toAdd.map((list) => list.id), ['first']);
    assert.deepEqual(result.skipped.map((list) => list.id), ['second']);
});

test('searchLists matches names, descriptions, maintainers and topics', () => {
    const lists = catalog().lists;
    assert.deepEqual(B.searchLists(lists, 'BETA').map((list) => list.id), ['beta']);
    assert.deepEqual(B.searchLists(lists, 'trackers').map((list) => list.id), ['alpha']);
    assert.deepEqual(B.searchLists(lists, 'regional').map((list) => list.id), ['gamma']);
    assert.deepEqual(B.searchLists(lists, '   ').length, 3);
});

test('healthInfo maps statuses to display labels', () => {
    assert.deepEqual(B.healthInfo({ status: 'ok' }), { label: 'Healthy', kind: 'ok' });
    assert.deepEqual(B.healthInfo({ status: 'warn' }), { label: 'Warning', kind: 'warn' });
    assert.deepEqual(B.healthInfo({ status: 'fail' }), { label: 'Failing', kind: 'fail' });
    assert.deepEqual(B.healthInfo(null), { label: 'Unknown', kind: 'unknown' });
});
