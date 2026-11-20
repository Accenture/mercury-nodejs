// Who is at the UI. Under `none` (development) nobody is asked and the person types a name the decision carries.
// Under `oauth2` the UI is a public client: Authorization Code with PKCE against the issuer the backend names,
// the token kept for the tab and sent as a bearer on every call - the field's installations use 3-legged SSO
// and OAuth 2.0 access tokens, so there is no gateway header and no cookie session here.
import { UserManager, WebStorageStateStore, type User } from 'oidc-client-ts';
import type { UiConfig } from './types';

export interface Session {
  mode: 'none' | 'oauth2';
  /** The person the token names (null under none: the person types a name). */
  who: string | null;
  /** The headers every call carries. */
  headers(): Promise<Record<string, string>>;
  signOut?(): Promise<void>;
}

export const NONE: Session = { mode: 'none', who: null, headers: async () => ({}) };

export function nameOf(user: User): string | null {
  const profile = user.profile as { preferred_username?: unknown; email?: unknown; sub?: unknown };
  for (const claim of [profile.preferred_username, profile.email, profile.sub]) {
    if (typeof claim === 'string' && claim) return claim;
  }
  return null;
}

export function managerFor(config: NonNullable<UiConfig['oauth2']>, redirect: string): UserManager {
  return new UserManager({
    authority: config.issuer,
    client_id: config.client_id,
    redirect_uri: redirect,
    response_type: 'code',
    scope: config.scopes || 'openid',
    loadUserInfo: false,
    automaticSilentRenew: false,
    userStore: new WebStorageStateStore({ store: window.sessionStorage }),
    extraQueryParams: config.audience ? { audience: config.audience } : undefined
  });
}

/**
 * The session for the configuration: `none` at once; under `oauth2` the sign-in callback is completed when the page
 * returns from the issuer, else the person is sent there (the returned promise never settles, the page is leaving).
 */
export async function establish(config: UiConfig, manager?: UserManager): Promise<Session> {
  if (config.auth !== 'oauth2' || !config.oauth2) return NONE;
  const redirect = `${window.location.origin}${window.location.pathname}`;
  const users = manager ?? managerFor(config.oauth2, redirect);
  const params = new URLSearchParams(window.location.search);
  if (params.has('code') && params.has('state')) {
    await users.signinCallback();
    window.history.replaceState(null, '', window.location.pathname);
  }
  let user = await users.getUser();
  if (!user || user.expired) {
    await users.signinRedirect();
    return new Promise<Session>(() => {});
  }
  return {
    mode: 'oauth2',
    who: nameOf(user),
    headers: async () => {
      user = await users.getUser();
      if (!user || user.expired) {
        await users.signinRedirect();
        return new Promise<Record<string, string>>(() => {});
      }
      return { authorization: `Bearer ${user.access_token}` };
    },
    signOut: async () => {
      await users.removeUser();
      await users.signoutRedirect().catch(() => window.location.reload());
    }
  };
}
