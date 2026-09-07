import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isNotSecuredEnvironment,
  isSecuredEnvironment,
} from './security.environment';

test('NOT_SECURED is enabled only by an explicit true value', () => {
  assert.equal(isNotSecuredEnvironment('true'), true);
  assert.equal(isNotSecuredEnvironment(' TRUE '), true);
  assert.equal(isNotSecuredEnvironment('false'), false);
  assert.equal(isNotSecuredEnvironment(''), false);
  assert.equal(isNotSecuredEnvironment(undefined), false);
});

test('the secure environment remains enabled for NOT_SECURED=false', () => {
  assert.equal(isSecuredEnvironment('false'), true);
  assert.equal(isSecuredEnvironment(undefined), true);
  assert.equal(isSecuredEnvironment('true'), false);
});
