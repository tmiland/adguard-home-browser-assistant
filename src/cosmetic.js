'use strict';

/*
 * Element hiding for the AdGuard Home Browser Assistant.
 *
 * AGH stores Adblock-style cosmetic rules in its user rules, but a DNS server
 * cannot apply them. This content script reads those rules (and the extension's
 * local rules) and injects the matching CSS. It also provides the "pick an
 * element" UI used by the toolbar and context menu.
 */
(() => {
    const api = (typeof browser !== 'undefined' && browser.runtime && typeof browser.runtime.sendMessage === 'function')
        ? browser
        : null;
    if (!api) return;

    const HOST = String(location.hostname || '').toLowerCase().replace(/\.$/, '');
    const STYLE_ID = 'agh-assistant-cosmetic-style';
    const ROOT_ID = 'agh-assistant-picker-root';
    const MAX_CSS = 200000;

    let rawRules = [];
    let lastAppliedKey = '';
    let applySeq = 0;
    let picker = null;
    let refreshTimer = null;

    function validSelector(selector) {
        if (!selector || typeof selector !== 'string') return false;
        try {
            document.querySelector(selector);
            return true;
        } catch (_) {
            return false;
        }
    }

    function buildCss(built) {
        const lines = [];
        for (const rule of built.hide) {
            if (validSelector(rule.selector)) {
                lines.push(rule.selector + ' { display: none !important; }');
            }
        }
        for (const rule of built.style) {
            if (!validSelector(rule.selector)) continue;
            const probe = document.createElement('style');
            try {
                /* Validate the declaration block before handing it to the
                   browser-level CSS injector. */
                (document.head || document.documentElement).appendChild(probe);
                probe.sheet.insertRule(rule.selector + ' { ' + rule.body + ' }', 0);
                lines.push(rule.selector + ' { ' + rule.body + ' }');
            } catch (_) {
                /* Unsupported extended CSS is skipped, not executed. */
            } finally {
                probe.remove();
            }
        }
        return lines.join('\n');
    }

    function applyDomCss(css) {
        let style = document.getElementById(STYLE_ID);
        if (!css) {
            if (style) style.remove();
            return;
        }
        if (!style) {
            style = document.createElement('style');
            style.id = STYLE_ID;
            (document.head || document.documentElement).appendChild(style);
        }
        style.textContent = css;
    }

    function applyRules(rules) {
        if (!HOST) return { hide: 0, style: 0 };
        const built = AGHCosmeticRules.buildForHost(rules || [], HOST);
        const css = buildCss(built);
        const key = css + '|' + built.hide.length + '|' + built.style.length;
        rawRules = Array.isArray(rules) ? rules.slice() : [];
        if (key === lastAppliedKey) return built;

        lastAppliedKey = key;
        const seq = ++applySeq;

        api.runtime.sendMessage({ type: 'apply-cosmetic-css', css }).then((res) => {
            if (seq !== applySeq) return;
            if (!res || !res.ok) applyDomCss(css);
        }).catch(() => {
            if (seq === applySeq) applyDomCss(css);
        });

        console.debug('[AGH Cosmetic] %s: %d hide, %d style', HOST, built.hide.length, built.style.length);
        return built;
    }

    async function refresh(force) {
        if (!HOST) return;
        let cfg = {
            cosmeticEnabled: true,
            cosmeticRules: [],
            aghCosmeticCache: null,
        };
        try {
            cfg = await api.storage.local.get(cfg);
        } catch (_) {
            /* Use defaults if storage is unavailable. */
        }

        if (cfg.cosmeticEnabled === false) {
            applyRules([]);
            return;
        }

        const localRules = Array.isArray(cfg.cosmeticRules) ? cfg.cosmeticRules : [];
        const cached = cfg.aghCosmeticCache && Array.isArray(cfg.aghCosmeticCache.rules)
            ? cfg.aghCosmeticCache.rules
            : [];
        if (!rawRules.length && (localRules.length || cached.length)) {
            applyRules(cached.concat(localRules));
        }

        try {
            const res = await api.runtime.sendMessage({
                type: 'get-cosmetic',
                host: HOST,
                force: !!force,
            });
            if (res && res.ok && Array.isArray(res.rules)) {
                applyRules(res.rules);
            }
        } catch (_) {
            /* The cached/local rules above remain in effect. */
        }
    }

    function scheduleRefresh(force) {
        if (refreshTimer) window.clearTimeout(refreshTimer);
        refreshTimer = window.setTimeout(() => {
            refreshTimer = null;
            void refresh(force);
        }, 120);
    }

    api.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes.cosmeticEnabled || changes.cosmeticRules) scheduleRefresh(false);
    });

    /* ---------------------------------------------------------------------
     * Element picker
     */

    function stableClasses(el) {
        return Array.from(el.classList || []).filter((name) => {
            if (!name || name.length > 40) return false;
            if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) return false;
            if (/[a-f0-9]{8,}/i.test(name)) return false;
            if (/\d{3,}/.test(name)) return false;
            return true;
        }).slice(0, 3);
    }

    function uniqueSelector(el) {
        if (el.id) {
            const idSelector = '#' + CSS.escape(el.id);
            try {
                if (document.querySelectorAll(idSelector).length === 1) return idSelector;
            } catch (_) {
                /* fall through */
            }
        }

        const parts = [];
        let node = el;
        while (node && node.nodeType === 1 && node !== document.documentElement) {
            let part = node.localName || '*';
            const classes = stableClasses(node).slice(0, 2);
            if (classes.length) part += '.' + classes.map((name) => CSS.escape(name)).join('.');
            const parent = node.parentElement;
            if (parent) {
                const sameTag = Array.from(parent.children).filter((child) => child.localName === node.localName);
                if (sameTag.length > 1) part += ':nth-of-type(' + (sameTag.indexOf(node) + 1) + ')';
            }
            parts.unshift(part);
            const selector = parts.join(' > ');
            try {
                if (document.querySelectorAll(selector).length === 1) return selector;
            } catch (_) {
                /* Keep building the path. */
            }
            node = parent;
        }
        return parts.join(' > ') || (el.localName || '*');
    }

    function sharedSelector(el) {
        const classes = stableClasses(el);
        if (classes.length) {
            const selector = el.localName + '.' + classes.map((name) => CSS.escape(name)).join('.');
            try {
                if (document.querySelectorAll(selector).length > 1) return selector;
            } catch (_) {
                /* fall through */
            }
        }
        return uniqueSelector(el);
    }

    function describeElement(el) {
        let text = el.localName || 'element';
        if (el.id) text += '#' + el.id;
        const classes = stableClasses(el);
        if (classes.length) text += '.' + classes.slice(0, 2).join('.');
        return text;
    }

    const PICKER_CSS = `
            [hidden] { display: none !important; }
            :host { all: initial; }
            * { box-sizing: border-box; }
            .outline {
                position: fixed;
                pointer-events: none;
                border: 2px solid #4d995f;
                background: rgba(77, 153, 95, 0.12);
                border-radius: 3px;
                z-index: 2147483646;
            }
            .tip {
                position: fixed;
                pointer-events: none;
                max-width: 360px;
                padding: 3px 7px;
                border-radius: 5px;
                background: #14261a;
                color: #fff;
                font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                z-index: 2147483647;
            }
            .bar {
                display: flex;
                align-items: center;
                gap: 14px;
                max-width: calc(100vw - 24px);
                padding: 9px 12px;
                border-radius: 9px;
                background: #14261a;
                color: #fff;
                box-shadow: 0 8px 28px rgba(0, 0, 0, 0.3);
                font: 12px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            }
            .bar b { color: #9fe3ac; font-weight: 700; }
            button {
                appearance: none;
                border: 1px solid transparent;
                border-radius: 6px;
                padding: 6px 10px;
                font: inherit;
                font-weight: 650;
                cursor: pointer;
            }
            .cancel { color: #fff; background: transparent; border-color: rgba(255, 255, 255, 0.28); }
            .cancel:hover { border-color: #fff; }
            .panel {
                width: 100%;
                padding: 14px;
                border-radius: 12px;
                background: #fff;
                color: #171b18;
                box-shadow: 0 14px 40px rgba(0, 0, 0, 0.3);
                font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            }
            .title { font-size: 14px; font-weight: 720; margin-bottom: 9px; }
            .label { color: #637068; font-size: 10.5px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; }
            input[type="text"] {
                width: 100%;
                margin-top: 4px;
                padding: 7px 8px;
                border: 1px solid #d9e2db;
                border-radius: 6px;
                color: #171b18;
                background: #f7faf7;
                font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
            }
            .meta { color: #637068; font-size: 11px; margin-top: 6px; }
            .checkrow { display: flex; align-items: center; gap: 7px; margin-top: 9px; color: #171b18; }
            .error { min-height: 1.2em; margin-top: 7px; color: #b3261e; font-size: 11px; font-weight: 600; }
            .actions { display: flex; gap: 8px; margin-top: 10px; }
            .hide { flex: 1; color: #fff; background: #4d995f; }
            .hide:hover { background: #387aff; }
            .hide:disabled { opacity: 0.6; cursor: wait; }
            .panel .cancel { color: #171b18; border-color: #d9e2db; }
            .toast {
                max-width: min(420px, calc(100vw - 32px));
                padding: 10px 13px;
                border-radius: 8px;
                background: #14261a;
                color: #fff;
                box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
                font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            }
    `;

    function startPicker() {
        if (window.top !== window) return { ok: false, message: 'Use the picker in the top frame.' };
        if (!HOST) return { ok: false, message: 'Element hiding is not available on this page.' };
        if (picker) return { ok: true, already: true };

        const root = document.createElement('div');
        root.id = ROOT_ID;
        root.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483645; pointer-events: none;';
        const overlay = root.attachShadow({ mode: 'open' });
        overlay.innerHTML = `
            <div class="outline" hidden></div>
            <div class="tip" hidden></div>
        `;
        const overlayStyle = document.createElement('style');
        overlayStyle.textContent = PICKER_CSS;
        overlay.prepend(overlayStyle);

        /* Only this small box is interactive; the page stays clickable
           everywhere else. */
        const ui = document.createElement('div');
        ui.id = ROOT_ID + '-ui';
        ui.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; pointer-events: auto; display: block; top: 14px; left: 50%; transform: translateX(-50%); width: max-content; max-width: calc(100vw - 24px);';
        const shadow = ui.attachShadow({ mode: 'open' });
        shadow.innerHTML = `
            <div class="bar">
                <span>Click the element to hide. <b>Esc</b> cancels.</span>
                <button class="cancel" type="button" data-action="cancel">Cancel</button>
            </div>
            <div class="panel" hidden>
                <div class="title">Hide element</div>
                <div class="label">CSS selector</div>
                <input type="text" class="selector" spellcheck="false" autocomplete="off">
                <div class="meta"></div>
                <label class="checkrow"><input type="checkbox" class="all"> Hide all matching elements</label>
                <div class="error" role="alert"></div>
                <div class="actions">
                    <button class="hide" type="button" data-action="apply">Hide</button>
                    <button class="cancel" type="button" data-action="cancel">Cancel</button>
                </div>
            </div>
            <div class="toast" hidden></div>
        `;
        const uiStyle = document.createElement('style');
        uiStyle.textContent = PICKER_CSS;
        shadow.prepend(uiStyle);

        (document.documentElement || document.body).appendChild(root);
        (document.documentElement || document.body).appendChild(ui);

        picker = {
            root,
            ui,
            shadow,
            candidate: null,
            selected: null,
            unique: '',
            shared: '',
            bar: shadow.querySelector('.bar'),
            panel: shadow.querySelector('.panel'),
            outline: overlay.querySelector('.outline'),
            tip: overlay.querySelector('.tip'),
            input: shadow.querySelector('.selector'),
            meta: shadow.querySelector('.meta'),
            all: shadow.querySelector('.all'),
            error: shadow.querySelector('.error'),
            toast: shadow.querySelector('.toast'),
            apply: shadow.querySelector('[data-action="apply"]'),
        };

        function inPicker(event) {
            if (!event.composedPath) return false;
            const path = event.composedPath();
            return path.includes(root) || path.includes(ui);
        }

        function positionOutline() {
            if (!picker || !picker.candidate) return;
            const rect = picker.candidate.getBoundingClientRect();
            if (!rect.width || !rect.height) {
                picker.outline.hidden = true;
                picker.tip.hidden = true;
                return;
            }
            picker.outline.hidden = false;
            picker.outline.style.left = rect.left + 'px';
            picker.outline.style.top = rect.top + 'px';
            picker.outline.style.width = rect.width + 'px';
            picker.outline.style.height = rect.height + 'px';

            picker.tip.hidden = false;
            picker.tip.textContent = describeElement(picker.candidate);
            const top = rect.top > 28 ? rect.top - 22 : rect.bottom + 5;
            picker.tip.style.left = Math.max(4, Math.min(rect.left, window.innerWidth - 370)) + 'px';
            picker.tip.style.top = Math.max(4, top) + 'px';
        }

        function setCandidate(el) {
            if (!picker || !el || el === root || el === ui) return;
            picker.candidate = el;
            positionOutline();
        }

        function onMove(event) {
            if (!picker || picker.selected || inPicker(event)) return;
            const el = document.elementFromPoint(event.clientX, event.clientY);
            if (!el || el === root || el === ui) return;
            setCandidate(el);
        }

        function onClick(event) {
            if (!picker || inPicker(event)) return;
            if (event.button && event.button !== 0) return;
            const el = document.elementFromPoint(event.clientX, event.clientY);
            if (!el || el === root || el === ui) return;
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            select(el);
        }

        function onKey(event) {
            if (!picker) return;
            if (event.key === 'Escape') {
                event.preventDefault();
                closePicker();
            } else if (event.key === 'Enter' && picker.selected) {
                event.preventDefault();
                void applyPicked();
            }
        }

        function select(el) {
            if (!picker) return;
            picker.selected = el;
            picker.candidate = el;
            picker.outline.hidden = true;
            picker.tip.hidden = true;
            picker.bar.hidden = true;
            picker.panel.hidden = false;
            picker.ui.style.top = 'auto';
            picker.ui.style.left = 'auto';
            picker.ui.style.transform = 'none';
            picker.ui.style.right = '16px';
            picker.ui.style.bottom = '16px';
            picker.ui.style.width = 'min(360px, calc(100vw - 32px))';
            picker.unique = uniqueSelector(el);
            picker.shared = sharedSelector(el);
            picker.input.value = picker.all.checked ? picker.shared : picker.unique;
            picker.error.textContent = '';
            updateMeta();
        }

        function updateMeta() {
            if (!picker) return;
            const selector = picker.input.value.trim();
            let count = 0;
            try {
                count = selector ? document.querySelectorAll(selector).length : 0;
            } catch (_) {
                count = -1;
            }
            if (count < 0) {
                picker.meta.textContent = 'Invalid selector';
            } else {
                picker.meta.textContent = count === 1
                    ? 'Hides 1 element'
                    : `Hides ${count} elements`;
            }
        }

        async function applyPicked() {
            if (!picker) return;
            const selector = picker.input.value.trim();
            if (!selector) {
                picker.error.textContent = 'Enter a CSS selector.';
                return;
            }
            if (!validSelector(selector)) {
                picker.error.textContent = 'That selector is not valid CSS.';
                return;
            }

            picker.apply.disabled = true;
            picker.error.textContent = '';
            try {
                const res = await api.runtime.sendMessage({
                    type: 'add-cosmetic',
                    host: HOST,
                    selector,
                });
                if (!res || !res.ok) {
                    picker.error.textContent = (res && res.message) || 'Could not save the rule.';
                    picker.apply.disabled = false;
                    return;
                }
                let rules = Array.isArray(res.rules) ? res.rules : rawRules.slice();
                const rule = `${HOST}##${selector}`;
                if (!rules.includes(rule)) rules = rules.concat(rule);
                applyRules(rules);
                showToast(res.message || 'Element hidden.');
            } catch (e) {
                picker.error.textContent = 'Could not save the rule: ' + (e && e.message ? e.message : String(e));
                picker.apply.disabled = false;
            }
        }

        function showToast(message) {
            if (!picker) return;
            picker.panel.hidden = true;
            picker.bar.hidden = true;
            picker.toast.hidden = false;
            picker.toast.textContent = message;
            picker.ui.style.top = 'auto';
            picker.ui.style.left = 'auto';
            picker.ui.style.transform = 'none';
            picker.ui.style.right = '16px';
            picker.ui.style.bottom = '16px';
            picker.ui.style.width = 'max-content';
            window.setTimeout(() => closePicker(), 2200);
        }

        function closePicker() {
            if (!picker) return;
            document.removeEventListener('mousemove', onMove, true);
            document.removeEventListener('click', onClick, true);
            document.removeEventListener('keydown', onKey, true);
            window.removeEventListener('scroll', positionOutline, true);
            window.removeEventListener('resize', positionOutline, true);
            picker.root.remove();
            picker.ui.remove();
            picker = null;
        }

        document.addEventListener('mousemove', onMove, true);
        document.addEventListener('click', onClick, true);
        document.addEventListener('keydown', onKey, true);
        window.addEventListener('scroll', positionOutline, true);
        window.addEventListener('resize', positionOutline, true);

        shadow.querySelectorAll('[data-action="cancel"]').forEach((button) => {
            button.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                closePicker();
            });
        });
        picker.apply.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            void applyPicked();
        });
        picker.input.addEventListener('input', updateMeta);
        picker.all.addEventListener('change', () => {
            if (!picker) return;
            picker.input.value = picker.all.checked ? picker.shared : picker.unique;
            updateMeta();
        });

        return { ok: true };
    }

    api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (!msg || typeof msg.type !== 'string') return undefined;
        if (msg.type === 'cosmetic-pick') {
            if (window.top !== window) return undefined;
            sendResponse(startPicker());
            return false;
        }
        if (msg.type === 'cosmetic-refresh') {
            refresh(!!msg.force).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
            return true;
        }
        return undefined;
    });

    void refresh(false);

})();
