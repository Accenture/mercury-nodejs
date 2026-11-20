# agent-question-ui - the front-end of the agent-question app

The one React front-end of the **agent-question** app, maintained here for both language packs (Eric, 2026-11-19: one
app to maintain in one place; the agent-question app is the backend in the Python and the Node.js pack, this is its
front-end). It shows a person the questions an agent asks, takes the decisions back, keeps the history and browses
the transcripts behind them - RFC-0014 round 4, build plan step 11.

Three panels:

- **Waiting for you** - every case with a card that waits for a decision - an approval (approve or refuse each waiting
  call, with a note for the model) or a question (pick an option or type an answer) - or an advice this device has
  not seen. The decision goes to the backend's click, `POST /questions/{id}/decide`, which invokes the link on the
  person's behalf; the card closes when the record says so, the advices that follow stay until marked *Seen*.
- **History** - the closed cases in a viewport with infinite scroll: the newest page is read at start
  (`GET /questions?before=`), older pages as the person scrolls to the end (`GET /questions?before=<seq>`), and the
  stream (`GET /questions/events`, read with `fetch` and `Last-Event-ID` so it carries the bearer `EventSource`
  cannot) keeps every card current. Useful even when nobody answers here: a chat, mail or topic channel delivers the
  same messages, and a topic has no convenient browser of its history.
- **Transcripts** - the transcript audit store the LLM helper writes: the conversations newest first
  (`GET /transcripts`, filtered by correlation id or graph id - a case's *transcripts* link opens its own), one
  conversation with its turns, the requests and responses as the model exchanged them.
- **Actuator** - the host's actuator endpoints as a menu, as the Playground web app offers the engine's: Info
  (`/info`), Services (`/info/routes`), Health (`/health`), Environment (`/env`) and Liveness probe (`/livenessprobe`),
  read from the same origin and shown with their status. The
  backend keeps them at their paths beside the bundle (a host path always wins over a file), so a container manager's
  probes and operations work unchanged when the app is deployed to the cloud.

The bundle is deployed into each backend's `resources/public`, which the pack's host serves from the backend's own
origin (the hosts' static content service, `static.html.folder`), so the app calls `/questions` and `/transcripts` by
absolute path on the same origin and needs no CORS. The brand mark is the Material Design *atom* icon the engine docs
use as their logo (`@mdi/js`, Apache-2.0), as the favicon and the header mark.

## Develop

```bash
npm install
# a backend on the agent-question port (8092) under question.auth: none, in either pack, e.g. from the repository root:
node dist/src/cli.js extensions/agent-question/agent-question.mjs
npm run dev          # http://localhost:5173 - the dev server proxies /questions and /transcripts to 127.0.0.1:8092
npm test             # vitest + testing-library on happy-dom
npm run typecheck
```

Under `question.auth: none` the header offers a name field; the decision carries it as `decided_by`, so the audit
store records who decided. The name is kept in the browser's local storage, nothing else is.

## Build and deploy

```bash
npm run release      # clean + build + deploy into both packs
npm run build        # typecheck, write public/favicon.svg from @mdi/js, vite build into dist/ (no source maps)
npm run deploy       # copy dist/ into ../agent-question/resources/public and the Python pack's
npm run deploy:node  # one target
npm run deploy:python
npm run clean        # remove what deploy wrote, in both packs
```

The Python pack is expected beside this repository, at `../../../mercury-python` relative to this folder; set
`MERCURY_PYTHON_REPO` to point elsewhere. The deploy replaces the previous bundle's `assets/` so stale hashes do not
pile up and touches nothing else in `resources/public`. **The bundle is committed in both repositories** - a release
of the UI is a build here and a commit in each pack - so a backend serves the UI out of the box: open
`http://127.0.0.1:8092/` once the backend runs. The published npm and PyPI packages ship no extension.

## Sign-in

`GET /questions/config` tells the UI how the backend is protected. `none` is development. `oauth2` makes the UI a
public client: Authorization Code with PKCE (`oidc-client-ts`) against the issuer, client id, scopes and audience the
backend names, the access token kept for the tab in session storage and sent as a bearer on every call - the field's
installations use 3-legged SSO and OAuth 2.0 access tokens, so there is no gateway-header mode and no cookie session.
A 401 on the stream sends the person back to the issuer.

A development issuer: `dev/keycloak.sh` runs Keycloak in a container with the realm of `dev/realm.json` imported - the
realm `mercury`, one public client `agent-question-ui` with PKCE whose access tokens carry the audience
`agent-question`, redirect URIs for the dev server (5173), the agent-question backend (8092) and the ask-person
reply page (8091). The realm file holds no credential: the admin console password (`KC_BOOTSTRAP_ADMIN_PASSWORD`) and
the test person's (`KEYCLOAK_TEST_PASSWORD`) come from the shell that runs the script and are never written to the
repository or printed.

```bash
KC_BOOTSTRAP_ADMIN_PASSWORD=... dev/keycloak.sh start      # prints the environment the backends take
KEYCLOAK_TEST_PASSWORD=... dev/keycloak.sh user            # a person to sign in as (KEYCLOAK_TEST_USER, default operator)
dev/keycloak.sh env                                        # the same environment again
dev/keycloak.sh stop
```

Then start the backend with `-Dquestion.auth=oauth2` (and the ask-person app with `-Dask.reply.auth=oauth2`) in that
environment; the dev server proxies the backend, and the issuer's redirect URI is the page's own address.

## Design notes

- **`seen` is the device's:** the record keeps no `seen` (RFC-0014 round 4), so the UI does. A case stays under
  *Waiting for you* while it has an open card or an advice this device has not seen - the acknowledgement and the
  outcome that follow a decision are read before the case leaves - and a *Seen* button moves it to the history (a
  *Mark all notices as seen* button clears a flood of advices at once; the cases that wait for a decision stay). The
  baseline is the newest sequence of the first page a device ever loaded, kept in local storage with the marked ids,
  so an older page of the history never floods the waiting panel.
- **One rule for a row:** the UI holds rows by id and a change with a higher sequence wins, whatever path it came by
  - the first page, an older page, the stream or the decision's reply. A case is a graph id plus a correlation id;
  its cards are shown in the order they were recorded (a wait stays above the advices that follow it), the cases
  newest activity first; a case with an open card or an unseen advice waits, the rest are history.
- **The stream starts where the first page ended:** the newest page's highest sequence is the cursor, so nothing
  between the page and the stream is missed; a stream that ends or fails reopens after two seconds from the last
  sequence seen.
- **A decision is final at the engine:** the reply tells the engine's outcome; a 4xx from the engine (a wait that is
  no longer there) is shown on the card and the row stays as the record left it.
- **The tests** fake `fetch` (`src/test/fixtures.ts`): rows as the backend's `publicRow()` serves them, the pages,
  the stream as a pushable `ReadableStream`, the click; the sign-in is tested against a fake `UserManager`.
