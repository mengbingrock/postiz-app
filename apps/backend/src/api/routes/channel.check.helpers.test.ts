import { describe, expect, it } from 'vitest';
import {
  hasLiveChannelProbe,
  linkedinPersonalProbeProviders,
  metaChannelAccessToken,
  refreshProbeProviders,
  xProbeProviders,
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
    expect(hasLiveChannelProbe('linkedin-page-byo')).toBe(true);
    expect(hasLiveChannelProbe('linkedin-byo')).toBe(true);
    expect(hasLiveChannelProbe('x')).toBe(true);
    expect(hasLiveChannelProbe('unknown-provider')).toBe(false);
  });

  it('checks LinkedIn personal channels with their access token', () => {
    expect(linkedinPersonalProbeProviders.has('linkedin')).toBe(true);
    expect(linkedinPersonalProbeProviders.has('linkedin-byo')).toBe(true);
    expect(refreshProbeProviders.has('linkedin')).toBe(false);
  });

  it('routes X through its access-token probe', () => {
    expect(xProbeProviders.has('x')).toBe(true);
    expect(refreshProbeProviders.has('x')).toBe(false);
  });
});
