import assert from 'node:assert/strict';
import test from 'node:test';
import { postListItem } from './posts.list.tool';

const post = {
  publishDate: new Date('2026-09-05T02:38:00Z'),
  content: '<p>test</p>',
  settings: '{}',
  group: 'group-1',
  integration: {
    id: 'integration-1',
    providerIdentifier: 'chineseinla',
    name: 'menbinwan',
  },
};

test('postListItem exposes a readable publication error', () => {
  const item = postListItem({
    ...post,
    id: 'post-1',
    state: 'ERROR',
    error: JSON.stringify({ message: 'ChineseInLA session expired' }),
  });

  assert.equal(item.error, 'ChineseInLA session expired');
});

test('postListItem returns null when a post has no publication error', () => {
  const item = postListItem({
    ...post,
    id: 'post-2',
    state: 'PUBLISHED',
    error: null,
  });

  assert.equal(item.error, null);
});
