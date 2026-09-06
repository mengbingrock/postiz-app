import assert from 'node:assert/strict';
import test from 'node:test';
import { postErrorMessage } from './post.error.message';

test('postErrorMessage preserves Error messages', () => {
  assert.equal(
    postErrorMessage(new Error('Browser session expired')),
    'Browser session expired'
  );
});

test('postErrorMessage extracts messages from serialized provider errors', () => {
  assert.equal(
    postErrorMessage('{"message":"ChineseInLA publish failed"}'),
    'ChineseInLA publish failed'
  );
});

test('postErrorMessage extracts the actionable message from Temporal failures', () => {
  assert.equal(
    postErrorMessage(
      JSON.stringify({
        cause: {
          failure: {
            message: 'ChineseInLA prepared form is no longer open',
            stackTrace: 'internal stack trace',
          },
        },
        failure: { message: 'Activity task failed' },
      })
    ),
    'ChineseInLA prepared form is no longer open'
  );
});
