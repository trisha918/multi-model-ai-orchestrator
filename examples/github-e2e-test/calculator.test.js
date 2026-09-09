'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { add, subtract } = require('./calculator.js');

test('add', () => {
  assert.equal(add(2, 3), 5);
  assert.equal(add(-1, 1), 0);
});

test('subtract', () => {
  assert.equal(subtract(5, 2), 3);
  assert.equal(subtract(0, 4), -4);
});
