// Emmet abbreviations, as VS Code expands them with Tab in HTML and XML.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abbreviationBefore, expandAbbreviation } from '../app/js/emmet.js';

const expand = (abbr, opts) => expandAbbreviation(abbr, { indent: '  ', ...opts });

test('elements, ids, classes, attributes, text', () => {
  assert.deepEqual(expand('div'), { text: '<div></div>', cursor: 5 });
  assert.equal(expand('div#main.box.wide').text, '<div id="main" class="box wide"></div>');
  assert.equal(expand('.card').text, '<div class="card"></div>');
  assert.equal(expand('p{Hello}').text, '<p>Hello</p>');
  assert.equal(expand('a[href=#top target=_blank]{Up}').text, '<a href="#top" target="_blank">Up</a>');
  assert.deepEqual(expand('a'), { text: '<a href=""></a>', cursor: 9 });
  assert.equal(expand('img').text, '<img src="" alt="">');
  assert.equal(expand('input[type=email]').text, '<input type="email">');
  assert.equal(expand('br').text, '<br>');
});

test('children, siblings, climbing, multiplying, numbering, groups', () => {
  assert.equal(expand('ul>li*3').text, '<ul>\n  <li></li>\n  <li></li>\n  <li></li>\n</ul>');
  assert.equal(expand('ul>.item$*2').text, '<ul>\n  <li class="item1"></li>\n  <li class="item2"></li>\n</ul>');
  assert.equal(expand('h$$*2').text, '<h01></h01>\n<h02></h02>');
  assert.equal(expand('div>p+p').text, '<div>\n  <p></p>\n  <p></p>\n</div>');
  assert.equal(expand('div>p>span^h2').text, '<div>\n  <p>\n    <span></span>\n  </p>\n  <h2></h2>\n</div>');
  assert.equal(expand('(header>nav)+main').text, '<header>\n  <nav></nav>\n</header>\n<main></main>');
  assert.equal(expand('table>tr*2>td*2').text, '<table>\n  <tr>\n    <td></td>\n    <td></td>\n  </tr>\n  <tr>\n    <td></td>\n    <td></td>\n  </tr>\n</table>');
  assert.equal(expand('li.n$@-*3').text, '<li class="n3"></li>\n<li class="n2"></li>\n<li class="n1"></li>');
  assert.equal(expand('span>.x').text, '<span>\n  <span class="x"></span>\n</span>');
  // "$" belongs to the nearest repeated one.
  assert.equal(expand('ul>li*2>a.x$').text, '<ul>\n  <li>\n    <a href="" class="x1"></a>\n  </li>\n  <li>\n    <a href="" class="x2"></a>\n  </li>\n</ul>');
  assert.equal(expand('(p.g$>span.s$*2)*2').text.split('\n').filter((l) => l.includes('class')).map((l) => l.trim()).join(' '), '<p class="g1"> <span class="s1"></span> <span class="s2"></span> <p class="g2"> <span class="s1"></span> <span class="s2"></span>');
});

test('a page, XML, and what is not an abbreviation', () => {
  const page = expandAbbreviation('!', { indent: '  ' });
  assert.ok(page.text.startsWith('<!DOCTYPE html>\n<html lang="en">'));
  assert.equal(page.text.slice(page.cursor, page.cursor + 8), 'Document');
  // XML: tags as written, no empty-element rules or implicit tags.
  assert.equal(expand('item>br+.x', { xml: true }).text, '<item>\n  <br></br>\n  <div class="x"></div>\n</item>');
  assert.equal(expand('ns:Item[a=1]', { xml: true }).text, '<ns:Item a="1"></ns:Item>');
  for (const bad of ['', 'div>', 'a[b', '(p', 'p{x', '*3', '+p', 'hello world']) assert.equal(expandAbbreviation(bad), null, bad);
});

test('the abbreviation before the cursor', () => {
  assert.equal(abbreviationBefore('  ul>li*3'), 'ul>li*3');
  assert.equal(abbreviationBefore('<p>a[href=x y]'), 'a[href=x y]');
  assert.equal(abbreviationBefore('text p{Hello there}'), 'p{Hello there}');
  assert.equal(abbreviationBefore('<div>'), '');
  assert.equal(abbreviationBefore(''), '');
});
