const test = require('node:test');
const assert = require('node:assert/strict');
const { groupBursts } = require('../src/frontend/bursts.js');

test('suffix-numbered files form one burst, in number order', () => {
  const files = ['a/20231228_122526_10.JPG', 'a/20231228_122526.JPG', 'a/20231228_122526_2.JPG', 'a/20231228_122600.JPG']
    .map((path) => ({ path, time: null }));
  const g = groupBursts(files);
  assert.equal(g.length, 2);
  assert.deepEqual(g.find((x) => x.paths.length === 3).paths, ['a/20231228_122526.JPG', 'a/20231228_122526_2.JPG', 'a/20231228_122526_10.JPG']);
});

test('camera-numbered files join by capture time (2 s gap)', () => {
  const t0 = 1700000000;
  const files = [['DSC01697.JPG', t0], ['DSC01698.JPG', t0 + 1], ['DSC01699.JPG', t0 + 2], ['DSC01700.JPG', t0 + 30], ['DSC01701.JPG', t0 + 31], ['IMG.png', null]]
    .map(([path, time]) => ({ path, time }));
  const g = groupBursts(files);
  assert.deepEqual(g.map((x) => x.paths.length), [3, 2, 1]);
  assert.equal(g[0].name, 'DSC01697');
});

test('non-image names are ignored', () => {
  assert.deepEqual(groupBursts([{ path: 'notes.txt', time: null }]), []);
});
