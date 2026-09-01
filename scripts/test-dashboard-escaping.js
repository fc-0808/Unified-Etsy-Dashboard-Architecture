'use strict';

/** Static + executable regression checks for dashboard HTML/JS boundaries. */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.resolve(__dirname, '../public/index.html'), 'utf8');

assert.doesNotMatch(html, /innerHTML\s*=\s*`[^`]*\$\{(?:err|e)\.message\}/);
assert.doesNotMatch(html, /src="\$\{tx\.image_url\}"/);
assert.doesNotMatch(html, /src="\$\{l\.primary_image_url\}"/);
assert.doesNotMatch(html, /src="\$\{(?:d|it)\.image\}"/);
assert.doesNotMatch(html, /<span class="listing-tag">\$\{t\}<\/span>/);
assert.doesNotMatch(html, /href="\$\{l\.listing_url\}"/);
assert.doesNotMatch(html, /whoami\.innerHTML/);
assert.doesNotMatch(html, /title="\$\{titleTxt\.replace/);
assert.doesNotMatch(html, /buyerMsg\.replace\(\/<\//);
assert.doesNotMatch(html, /class="audit-product-thumb"[^>]*src="\$\{image\}"/);
assert.match(html, /class="audit-product-thumb"[^>]*src="\$\{_escHtml\(image\)\}"/);
assert.doesNotMatch(html, /class="audit-product-title"[^>]*title="\$\{title\}"/);
assert.match(html, /class="audit-product-title"[^>]*title="\$\{_escHtml\(title\)\}"/);
assert.doesNotMatch(html, /<a\b[^>]*\bclass=["'][^"']*\baudit-product-media\b/);

const jsAttrSource = html.match(/function jsAttr\(str\)\s*\{[\s\S]*?\n\s*\}/);
assert.ok(jsAttrSource, 'shipped jsAttr helper must be present');
const context = {};
vm.runInNewContext(`${jsAttrSource[0]}; result = jsAttr("x\\\\'\\n\\r\\u2028\\"><img src=x>&");`, context);
const escaped = context.result;
assert.equal(/[\n\r\u2028\u2029]/.test(escaped), false, 'JavaScript attribute value contains a raw line terminator');
assert.equal(escaped.includes('<'), false, 'JavaScript attribute value contains raw markup');
assert.match(escaped, /\\'/, 'single quote is not escaped for the inline JavaScript string');
assert.match(escaped, /&quot;/, 'double quote is not escaped for the HTML attribute');
assert.match(escaped, /&amp;/, 'ampersand is not escaped for the HTML attribute');

console.log('PASS — dashboard dynamic HTML uses total text, attribute, and inline-JS escaping');
