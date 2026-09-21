import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseExpr, referencedVars, testCondition, ExprError } from '../shared/engine/expr.ts';

describe('expression evaluator', () => {
  test('compares a variable to a string literal', () => {
    assert.equal(testCondition("approach == 'reply'", { approach: 'reply' }), true);
    assert.equal(testCondition("approach == 'reply'", { approach: 'silent' }), false);
    assert.equal(testCondition("approach != 'reply'", { approach: 'silent' }), true);
  });

  test('handles double quotes and escapes', () => {
    assert.equal(testCondition('name == "Ada"', { name: 'Ada' }), true);
    assert.equal(testCondition("name == 'O\\'Brien'", { name: "O'Brien" }), true);
  });

  test('undefined variables are falsy, never a crash', () => {
    assert.equal(testCondition("missing == 'x'", {}), false);
    assert.equal(testCondition('missing', {}), false);
    assert.equal(testCondition('!missing', {}), true);
  });

  test('&& and || with correct precedence', () => {
    const vars = { a: 'x', b: 'y' };
    assert.equal(testCondition("a == 'x' && b == 'y'", vars), true);
    assert.equal(testCondition("a == 'x' && b == 'z'", vars), false);
    assert.equal(testCondition("a == 'q' || b == 'y'", vars), true);
    // && binds tighter than ||
    assert.equal(testCondition("a == 'q' && b == 'q' || a == 'x'", vars), true);
  });

  test('parentheses override precedence', () => {
    const vars = { a: 'x', b: 'q' };
    assert.equal(testCondition("(a == 'q' || a == 'x') && b == 'q'", vars), true);
    assert.equal(testCondition("(a == 'q' || a == 'z') && b == 'q'", vars), false);
  });

  test('compares numbers written as strings, since YAML blurs the two', () => {
    assert.equal(testCondition('round == 2', { round: '2' }), true);
    assert.equal(testCondition("round == '2'", { round: 2 }), true);
    assert.equal(testCondition('round == 3', { round: '2' }), false);
  });

  test('booleans', () => {
    assert.equal(testCondition('flag == true', { flag: true }), true);
    assert.equal(testCondition('flag', { flag: true }), true);
    assert.equal(testCondition('flag', { flag: false }), false);
  });

  test('collects referenced variables for validator warnings', () => {
    const ast = parseExpr("approach == 'reply' && (disclosure == 'all' || urgency)");
    assert.deepEqual([...referencedVars(ast)].sort(), ['approach', 'disclosure', 'urgency']);
  });

  test('rejects malformed expressions rather than guessing', () => {
    assert.throws(() => parseExpr(''), ExprError);
    assert.throws(() => parseExpr("approach = 'reply'"), ExprError);
    assert.throws(() => parseExpr("(approach == 'reply'"), ExprError);
    assert.throws(() => parseExpr("approach == 'unterminated"), ExprError);
    assert.throws(() => parseExpr("approach == 'x' extra"), ExprError);
  });

  test('offers no way to execute code', () => {
    // No function calls, no property access, no globals.
    assert.throws(() => parseExpr('process.exit(1)'), ExprError);
    assert.throws(() => parseExpr('alert("x")'), ExprError);
  });
});
