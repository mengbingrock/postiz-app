import {
  ClientInformation,
  OAuthCredentialSetup,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import { AuthService } from '@gitroom/helpers/auth/auth.service';
import { Integration } from '@prisma/client';

const firstConfigured = (names: string[]) =>
  names.map((name) => process.env[name]?.trim()).find(Boolean) || '';

export const hasServerOAuthCredentials = (setup: OAuthCredentialSetup) =>
  !!firstConfigured(setup.clientIdEnv) &&
  !!firstConfigured(setup.clientSecretEnv);

export const resolveOAuthCredentials = (
  setup: OAuthCredentialSetup,
  supplied?: ClientInformation
): ClientInformation => ({
  client_id: supplied?.client_id?.trim() || firstConfigured(setup.clientIdEnv),
  client_secret:
    supplied?.client_secret?.trim() || firstConfigured(setup.clientSecretEnv),
  instanceUrl:
    supplied?.instanceUrl?.trim() || process.env.FRONTEND_URL?.trim() || '',
});

export const missingOAuthCredentialNames = (setup: OAuthCredentialSetup) => {
  const missing: string[] = [];
  if (!firstConfigured(setup.clientIdEnv)) {
    missing.push(setup.clientIdLabel);
  }
  if (!firstConfigured(setup.clientSecretEnv)) {
    missing.push(setup.clientSecretLabel);
  }
  return missing;
};

/**
 * Resolve the app credentials used by API calls after OAuth has completed.
 * User-supplied credentials are stored encrypted on the integration; legacy
 * and server-configured integrations continue to use environment defaults.
 */
export const resolveIntegrationOAuthCredentials = (
  setup: OAuthCredentialSetup,
  integration: Integration
) => {
  let supplied: ClientInformation | undefined;
  if (integration.customInstanceDetails) {
    try {
      supplied = JSON.parse(
        AuthService.fixedDecryption(integration.customInstanceDetails)
      );
    } catch {
      supplied = undefined;
    }
  }
  return resolveOAuthCredentials(setup, supplied);
};
