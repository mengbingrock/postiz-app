import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  redNoteCreatorPublishURL,
  resolveRedNoteSite,
} from './rednote.binary.installer';

const write = async (name: string, body: unknown) => {
  const dir = await mkdtemp(join(tmpdir(), 'rednote-site-'));
  const file = join(dir, name);
  await writeFile(
    file,
    typeof body === 'string' ? body : JSON.stringify(body)
  );
  return file;
};

test('resolveRedNoteSite defaults to cn without a readable file', async () => {
  assert.equal(await resolveRedNoteSite(undefined), 'cn');
  assert.equal(await resolveRedNoteSite('/nonexistent/cookies.json'), 'cn');
  assert.equal(await resolveRedNoteSite(await write('e.json', 'not json')), 'cn');
});

test('resolveRedNoteSite honours the stamped site key over cookie contents', async () => {
  assert.equal(
    await resolveRedNoteSite(
      await write('a.json', { version: 2, site: 'intl', cookies: [] })
    ),
    'intl'
  );
  assert.equal(
    await resolveRedNoteSite(
      await write('b.json', {
        version: 2,
        site: 'cn',
        cookies: [{ name: 'id_token', domain: '.rednote.com' }],
      })
    ),
    'cn'
  );
});

test('resolveRedNoteSite classifies older files from their cookies', async () => {
  assert.equal(
    await resolveRedNoteSite(
      await write('c.json', {
        version: 2,
        cookies: [{ name: 'id_token', domain: '.rednote.com' }],
      })
    ),
    'intl'
  );
  assert.equal(
    await resolveRedNoteSite(
      await write('d.json', [{ name: 'web_session', domain: '.xiaohongshu.com' }])
    ),
    'cn'
  );
});

test('redNoteCreatorPublishURL maps sites to creator centers', () => {
  assert.equal(
    redNoteCreatorPublishURL('cn'),
    'https://creator.xiaohongshu.com/publish/publish'
  );
  assert.equal(
    redNoteCreatorPublishURL('intl'),
    'https://creator.rednote.com/publish/publish'
  );
});
