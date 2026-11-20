// The shapes the agent-question backend serves (extensions/agent-question in either pack): the row of the
// question record, the pages of the replay and the history, the UI's configuration, and the transcript audit
// store's conversations and turns.

export type Kind = 'approval' | 'question' | 'advice';
export type State = 'open' | 'answered' | 'expired' | null;

export interface Call {
  id: string;
  name?: string;
  route?: string;
  wait?: boolean;
  ask?: boolean;
  input?: Record<string, unknown> | null;
}

export type Decision = { id: string; approved: boolean; note?: string } | { id: string; answer: unknown };

export interface Outcome {
  status: number | null;
  body: unknown;
}

export interface Row {
  id: number;
  seq: number;
  kind: Kind;
  graph_id: string;
  correlation_id: string;
  turn: number | null;
  ticket: string | null;
  link: string | null;
  description: string;
  summary: string;
  details: string | null;
  calls: Call[] | null;
  state: State;
  requested_at: string;
  expires_at: string | null;
  updated_at: string;
  answered_at: string | null;
  answered_by: string | null;
  decisions: Decision[] | null;
  outcome: Outcome | null;
}

export interface Page {
  rows: Row[];
  next: number | null;
  more: boolean;
}

export interface UiConfig {
  auth: 'none' | 'oauth2';
  title: string;
  oauth2?: { issuer: string; client_id: string; scopes: string; audience: string };
}

export interface Conversation {
  conversation: string;
  correlation_id: string | null;
  graph_id: string | null;
  node: string | null;
  model: string;
  status: string;
  turns: number;
  started_at: string;
  updated_at: string;
  ended_at: string | null;
  expires_at: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  system?: string | null;
  tools?: unknown;
}

export interface Turn {
  turn: number;
  trace_id: string | null;
  trace_path: string | null;
  correlation_id: string | null;
  started_at: string;
  ended_at: string;
  stop_reason: string | null;
  status: string;
  request_id: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  request: unknown;
  response: unknown;
  calls: unknown;
}

export interface TranscriptsPage {
  conversations: Conversation[];
  next: string | null;
  more: boolean;
}

export interface Transcript {
  conversation: Conversation;
  turns: Turn[];
}

/** The engines' actuator endpoints every pack host serves. */
export const ACTUATOR = [
  { path: '/info', label: 'Info', about: 'the application, its runtime and the host' },
  { path: '/info/routes', label: 'Services', about: 'the routing table - public and private functions' },
  { path: '/health', label: 'Health', about: 'the mandatory dependencies, each reporting' },
  { path: '/env', label: 'Environment', about: 'the opt-in environment variables and properties' },
  { path: '/livenessprobe', label: 'Liveness probe', about: 'OK while the last health outcome is good' }
] as const;

export type ActuatorPath = (typeof ACTUATOR)[number]['path'];

export interface ActuatorResult {
  path: ActuatorPath;
  status: number;
  contentType: string;
  body: string;
  at: string;
}
