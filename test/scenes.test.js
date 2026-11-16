const test = require('node:test');
const assert = require('node:assert/strict');
const { SCENES, byId, guideHtml } = require('../src/frontend/scenes.js');

test('every scene has a label, tips and an expectation', () => {
  for (const s of SCENES) {
    assert.ok(s.id && s.label && s.pitch, s.id);
    assert.ok(s.tips.length >= 3 && s.tips.every((t) => t.length > 20), s.id + ' tips');
    assert.ok(s.expect.length > 20, s.id + ' expect');
  }
  assert.deepEqual(SCENES.map((s) => s.id), ['landscape', 'night', 'handheld']);
});

test('byId finds scenes and returns null for unknown ids', () => {
  assert.equal(byId('night').label, 'Night');
  assert.equal(byId('nope'), null);
});

test('guideHtml renders the tips of a scene, empty for none', () => {
  const html = guideHtml('night');
  assert.equal((html.match(/<li>/g) || []).length, byId('night').tips.length);
  assert.match(html, /scene-expect/);
  assert.equal(guideHtml(''), '');
  assert.equal(guideHtml('nope'), '');
});

test('only the Night guide offers to shoot a burst', () => {
  assert.match(guideHtml('night'), /class="scene-shoot"/);
  assert.doesNotMatch(guideHtml('landscape'), /scene-shoot/);
  assert.doesNotMatch(guideHtml('handheld'), /scene-shoot/);
});
