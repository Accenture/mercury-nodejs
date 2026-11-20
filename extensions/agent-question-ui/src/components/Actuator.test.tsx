import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Api } from '../api';
import { fakeFetch, fakeResponse, headerOf } from '../test/fixtures';
import { Actuator, pretty } from './Actuator';

const INFO = { app: { name: 'agent-question', version: '1.0.0' }, origin: 'node' };

function hostFetch(health = 200) {
  return fakeFetch((url) => {
    switch (url.pathname) {
      case '/info': return fakeResponse({ body: INFO });
      case '/info/routes': return fakeResponse({ body: { routing: { public: ['agent.question.inbox'], private: ['question.health'] } } });
      case '/health': return fakeResponse({ status: health, body: { status: health === 200 ? 'UP' : 'DOWN', dependency: [{ route: 'question.health', status_code: health }] } });
      case '/env': return fakeResponse({ body: { env: { LOG_LEVEL: 'INFO' } } });
      case '/livenessprobe': return fakeResponse({ text: 'OK' });
      default: return fakeResponse({ status: 404, body: { message: 'no' } });
    }
  });
}

describe('Actuator', () => {
  it('opens on /info and reads another endpoint when picked', async () => {
    const { fetch, calls } = hostFetch();
    render(<Actuator api={new Api(async () => ({ authorization: 'Bearer t' }), fetch)} />);
    const result = await screen.findByTestId('actuator-result');
    expect(result).toHaveTextContent('GET /info');
    expect(result).toHaveTextContent('200');
    expect(result.querySelector('pre')?.textContent).toBe(JSON.stringify(INFO, null, 2));
    expect(calls[0].url).toBe('/info');
    expect(headerOf(calls[0].init, 'authorization')).toBe('Bearer t');
    fireEvent.click(screen.getByRole('button', { name: 'Services' }));
    await vi.waitFor(() => expect(screen.getByTestId('actuator-result')).toHaveTextContent('GET /info/routes'));
    expect(screen.getByTestId('actuator-result').querySelector('pre')?.textContent).toContain('agent.question.inbox');
    fireEvent.click(screen.getByRole('button', { name: 'Liveness probe' }));
    await vi.waitFor(() => expect(screen.getByTestId('actuator-result')).toHaveTextContent('GET /livenessprobe'));
    expect(screen.getByTestId('actuator-result').querySelector('pre')?.textContent).toBe('OK');
    expect(screen.getByTestId('actuator-result')).toHaveTextContent('text/plain');
  });

  it('shows an unhealthy answer with its status and refreshes on demand', async () => {
    const { fetch, calls } = hostFetch(503);
    render(<Actuator api={new Api(async () => ({}), fetch)} />);
    await screen.findByTestId('actuator-result');
    fireEvent.click(screen.getByRole('button', { name: 'Health' }));
    await vi.waitFor(() => expect(screen.getByTestId('actuator-result')).toHaveTextContent('GET /health'));
    expect(screen.getByTestId('actuator-result').querySelector('.status-bad')).toHaveTextContent('503');
    const before = calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await vi.waitFor(() => expect(calls.length).toBe(before + 1));
    expect(calls.at(-1)?.url).toBe('/health');
  });

  it('tells when the host cannot be reached', async () => {
    const fetch = (async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof globalThis.fetch;
    render(<Actuator api={new Api(async () => ({}), fetch)} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to fetch');
  });

  it('pretty-prints JSON and leaves text and broken JSON as they came', () => {
    const base = { path: '/info' as const, status: 200, at: '2026-11-20T08:00:00.000Z' };
    expect(pretty({ ...base, contentType: 'application/json', body: '{"a":1}' })).toBe('{\n  "a": 1\n}');
    expect(pretty({ ...base, contentType: 'application/json', body: '{broken' })).toBe('{broken');
    expect(pretty({ ...base, contentType: 'text/plain', body: 'OK' })).toBe('OK');
  });
});
