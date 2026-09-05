import {
  hasLiveChannelProbe,
  metaChannelAccessToken,
} from './channel.check.helpers';

describe('channel check helpers', () => {
  it('uses only the Instagram page token for Graph API checks', () => {
    expect(metaChannelAccessToken('instagram', 'page-token___user-token')).toBe(
      'page-token'
    );
  });

  it('leaves Facebook page tokens unchanged', () => {
    expect(metaChannelAccessToken('facebook', 'page-token')).toBe('page-token');
  });

  it('allows live providers to recover from a stale reconnect flag', () => {
    expect(hasLiveChannelProbe('instagram')).toBe(true);
    expect(hasLiveChannelProbe('youtube')).toBe(true);
    expect(hasLiveChannelProbe('chineseinla')).toBe(true);
    expect(hasLiveChannelProbe('unknown-provider')).toBe(false);
  });
});
