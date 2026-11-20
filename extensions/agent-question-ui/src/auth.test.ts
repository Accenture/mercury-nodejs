import { describe, expect, it, vi } from 'vitest';
import type { User, UserManager } from 'oidc-client-ts';
import { establish, managerFor, nameOf, NONE } from './auth';
import type { UiConfig } from './types';

const OAUTH2: UiConfig = {
  auth: 'oauth2',
  title: 'Agent questions',
  oauth2: { issuer: 'http://127.0.0.1:8180/realms/mercury', client_id: 'agent-question-ui', scopes: 'openid profile email', audience: 'agent-question' }
};

function user(over: Omit<Partial<User>, 'profile'> & { profile?: Record<string, unknown> } = {}): User {
  return { access_token: 'at-1', expired: false, profile: { sub: 'u-1', preferred_username: 'operator-1' }, ...over } as unknown as User;
}

function fakeManager(current: User | null) {
  const manager = {
    getUser: vi.fn(async () => current),
    signinRedirect: vi.fn(async () => {}),
    signinCallback: vi.fn(async () => {
      current = user();
      return current;
    }),
    removeUser: vi.fn(async () => {}),
    signoutRedirect: vi.fn(async () => {})
  };
  return manager as unknown as UserManager & typeof manager;
}

describe('establish', () => {
  it('needs nobody under none', async () => {
    const session = await establish({ auth: 'none', title: 't' });
    expect(session).toBe(NONE);
    expect(await session.headers()).toEqual({});
  });

  it('uses the signed-in person and sends the bearer on every call', async () => {
    const manager = fakeManager(user());
    const session = await establish(OAUTH2, manager);
    expect(session.mode).toBe('oauth2');
    expect(session.who).toBe('operator-1');
    expect(await session.headers()).toEqual({ authorization: 'Bearer at-1' });
    expect(manager.signinRedirect).not.toHaveBeenCalled();
  });

  it('completes the callback when the issuer sends the person back, and cleans the address', async () => {
    window.history.replaceState(null, '', '/?code=abc&state=xyz');
    const manager = fakeManager(null);
    const session = await establish(OAUTH2, manager);
    expect(manager.signinCallback).toHaveBeenCalledTimes(1);
    expect(window.location.search).toBe('');
    expect(session.who).toBe('operator-1');
  });

  it('sends a stranger to the issuer and never settles', async () => {
    const manager = fakeManager(null);
    const outcome = await Promise.race([establish(OAUTH2, manager), new Promise((r) => setTimeout(() => r('leaving'), 30))]);
    expect(outcome).toBe('leaving');
    expect(manager.signinRedirect).toHaveBeenCalledTimes(1);
  });

  it('signs out through the issuer', async () => {
    const manager = fakeManager(user());
    const session = await establish(OAUTH2, manager);
    await session.signOut?.();
    expect(manager.removeUser).toHaveBeenCalled();
    expect(manager.signoutRedirect).toHaveBeenCalled();
  });
});

describe('managerFor and nameOf', () => {
  it('configures a public client with PKCE against the issuer the backend names', () => {
    const manager = managerFor(OAUTH2.oauth2!, 'http://ui.test/');
    expect(manager.settings.authority).toBe(OAUTH2.oauth2!.issuer);
    expect(manager.settings.client_id).toBe('agent-question-ui');
    expect(manager.settings.response_type).toBe('code');
    expect(manager.settings.scope).toBe('openid profile email');
    expect(manager.settings.redirect_uri).toBe('http://ui.test/');
    expect(manager.settings.extraQueryParams).toEqual({ audience: 'agent-question' });
  });

  it('names the person by the preferred username, else the email, else the subject', () => {
    expect(nameOf(user())).toBe('operator-1');
    expect(nameOf(user({ profile: { sub: 'u-2', email: 'x@example.test' } }))).toBe('x@example.test');
    expect(nameOf(user({ profile: { sub: 'u-3' } }))).toBe('u-3');
  });
});
