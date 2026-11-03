'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/cosmetic-rules.js');

test('parses hide, exception, style, extended, script and comments', () => {
    assert.equal(C.parseRule('! comment'), null);
    assert.equal(C.parseRule('[Adblock Plus 2.0]'), null);
    assert.equal(C.parseRule('||ads.example^'), null);

    const hide = C.parseRule('example.com##.ad-banner');
    assert.equal(hide.type, 'hide');
    assert.deepEqual(hide.includes, ['example.com']);
    assert.equal(hide.selector, '.ad-banner');

    const generic = C.parseRule('##.ad-banner');
    assert.equal(generic.type, 'hide');
    assert.deepEqual(generic.includes, []);

    const exception = C.parseRule('example.com#@#.ad-banner');
    assert.equal(exception.type, 'exception');
    assert.equal(exception.selector, '.ad-banner');

    const style = C.parseRule('example.com#$#body { overflow: auto !important; }');
    assert.equal(style.type, 'style');
    assert.equal(style.selector, 'body');
    assert.equal(style.body, 'overflow: auto !important;');

    const styleException = C.parseRule('example.com#@$#body { overflow: auto !important; }');
    assert.equal(styleException.type, 'style-exception');

    const extended = C.parseRule('example.com#?#.ad:has(> .sponsor)');
    assert.equal(extended.type, 'hide');
    assert.equal(extended.selector, '.ad:has(> .sponsor)');

    const script = C.parseRule('example.com#%#window.ads = 0;');
    assert.equal(script.type, 'script');
});

test('domain matching includes subdomains, exclusions and wildcards', () => {
    assert.equal(C.matchesDomain('example.com', 'example.com'), true);
    assert.equal(C.matchesDomain('www.example.com', 'example.com'), true);
    assert.equal(C.matchesDomain('badexample.com', 'example.com'), false);
    assert.equal(C.matchesDomain('example.com', '*.example.com'), true);
    assert.equal(C.matchesDomain('a.example.com', '*.example.com'), true);
    assert.equal(C.matchesDomain('example.com', 'example.*'), true);
    assert.equal(C.matchesDomain('www.example.com', 'example.*'), true);
    assert.equal(C.matchesDomain('example.org', '*'), true);
});

test('builds applicable rules with exceptions', () => {
    const rules = [
        '##.generic-ad',
        'example.com##.site-ad',
        'example.com#@#.site-ad',
        '~example.com##.not-here',
        'example.com,~shop.example.com##.not-in-shop',
        'example.com#$#body { overflow: auto !important; }',
        'example.com#@$#body { overflow: auto !important; }',
        'example.com##.keep',
        'example.org##.other-site',
    ];

    const built = C.buildForHost(rules, 'www.example.com');
    assert.deepEqual(built.hide.map((r) => r.selector).sort(), ['.generic-ad', '.keep', '.not-in-shop']);
    assert.deepEqual(built.style, []);

    const shop = C.buildForHost(rules, 'shop.example.com');
    assert.deepEqual(shop.hide.map((r) => r.selector).sort(), ['.generic-ad', '.keep']);

    const other = C.buildForHost(rules, 'example.org');
    assert.deepEqual(other.hide.map((r) => r.selector).sort(), ['.generic-ad', '.not-here', '.other-site']);
});

test('generic exception removes the same selector everywhere', () => {
    const built = C.buildForHost(['##.ad', '#@#.ad', 'example.com##.banner'], 'www.example.com');
    assert.deepEqual(built.hide.map((r) => r.selector), ['.banner']);
});

test('emits CSS in hide-then-style order', () => {
    const built = C.buildForHost([
        'example.com##.ad',
        'example.com#$#body { overflow: auto !important; }',
    ], 'example.com');
    const css = C.toCss(built);
    assert.match(css, /\.ad \{ display: none !important; \}/);
    assert.match(css, /body \{ overflow: auto !important; \}/);
    assert.ok(css.indexOf('.ad') < css.indexOf('body'));
});

test('parses extended cosmetic selectors', () => {
    const hide = C.parseExtendedSelector('.ad:has-text(/sponsor/):upward(.feed)');
    assert.equal(hide.base, '.ad');
    assert.equal(hide.action, 'hide');
    assert.deepEqual(hide.tokens.map((t) => t.type), ['has-text', 'upward']);

    const style = C.parseExtendedSelector(
        'a[href="#"]:not(:has-text(/(\\s|\\d|^$)/)):upward([role="feed"]>div):style(border: 8px dotted yellow !important)',
    );
    assert.equal(style.base, 'a[href="#"]');
    assert.equal(style.action, 'style');
    assert.equal(style.style, 'border: 8px dotted yellow !important');
    assert.deepEqual(style.tokens.map((t) => t.type), ['not-has-text', 'upward', 'style']);

    const css = C.parseExtendedSelector('.ad:matches-css(display: none):remove()');
    assert.equal(css.action, 'hide');
    assert.deepEqual(css.tokens.map((t) => t.type), ['matches-css', 'remove']);

    assert.equal(C.parseExtendedSelector('.ad:not(.keep)'), null);
    assert.equal(C.parseExtendedSelector('.ad:hover'), null);
});

test('buildForHost keeps extended rules out of plain CSS', () => {
    const built = C.buildForHost([
        'example.com##.plain',
        'example.com##.ad:has-text(/sponsor/)',
        'example.com##.styled:style(color: red)',
    ], 'example.com');
    assert.deepEqual(built.hide.map((r) => r.selector), ['.plain']);
    assert.equal(built.extended.length, 2);
    assert.equal(built.extended[0].action, 'hide');
    assert.equal(built.extended[1].action, 'style');
    assert.equal(built.extended[1].style, 'color: red');
});
