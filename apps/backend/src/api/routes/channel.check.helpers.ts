export const existingTokenProbeProviders = new Set([
  'chineseinla',
  'rednote',
  'reddit-agent',
  'tajima-website',
]);

export const metaProbeProviders = new Set(['facebook', 'instagram']);

export const refreshProbeProviders = new Set([
  'gmb',
  'linkedin',
  'linkedin-page',
  'youtube',
]);

export const hasLiveChannelProbe = (providerIdentifier: string) =>
  existingTokenProbeProviders.has(providerIdentifier) ||
  metaProbeProviders.has(providerIdentifier) ||
  refreshProbeProviders.has(providerIdentifier);

export const metaChannelAccessToken = (
  providerIdentifier: string,
  storedToken: string
) =>
  providerIdentifier === 'instagram'
    ? storedToken.split('___', 1)[0]
    : storedToken;
