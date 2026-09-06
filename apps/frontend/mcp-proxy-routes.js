const prefixRoutes = [
  '/mcp',
  '/mcp-oauth',
  '/mcp-oauth-claude',
  '/sse',
  '/message',
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-authorization-server',
  '/.well-known/openid-configuration',
];

const exactRoutes = [
  '/.well-known/openai-apps-challenge',
  '/oauth/token',
  '/oauth/register',
  '/oauth/userinfo',
];

export const isPostizBackendProxyPath = (pathname) =>
  exactRoutes.includes(pathname) ||
  prefixRoutes.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );

export const buildPostizBackendRewrites = (backendUrl) => {
  const backend = backendUrl.replace(/\/+$/, '');
  return [
    ...prefixRoutes.map((prefix) => ({
      source: `${prefix}/:path*`,
      destination: `${backend}${prefix}/:path*`,
    })),
    ...exactRoutes.map((path) => ({
      source: path,
      destination: `${backend}${path}`,
    })),
  ];
};
