- [ ] **(blueprint) The React UI - the one front-end of the agent-question app, maintained here for both packs (Eric,
  2026-11-19: "a useful tool for demo and real-world operation"; "putting it only in the mercury-nodejs language pack so
  there is one app to maintain in one place"; "the agent-question app is the backend in both python and node repos and
  the React UI is the front-end").** The agent-question app of each pack is the backend: the inbox, the three endpoints,
  the stream and the identity modes - one contract, pinned by the shared vectors. The page it generates today (RFC-0014
  step 3) is one vanilla HTML file, byte-identical in both packs - cards grouped by case, a name field, the replay and the stream;
  on 2026-11-19 it gained a sticky header with the count of open cards, a *Waiting for you* section and a scrollable
  *History* panel that keeps its place while cards arrive. The front-end: a small React app over the same three endpoints
  (`GET /questions?since`, `GET /questions/events`, `POST /questions/{id}/decide` and `/seen`) and the same message
  shape - cards as components (approval, question, advice), the waiting list and the history with search and filters (by
  case, state, who decided, time), a per-device cursor kept in local storage, the identity modes unchanged (`none`,
  `proxy`, `oauth2`) - pointed at either backend: served by a backend as its page at `/questions/app` (same origin, no
  CORS), or hosted apart with the backend's base URL configured and its origin allowed. The Python pack's README points
  here; the vanilla page of both backends stays as the fallback. Settled 2026-11-20 (Eric's review of the sprint and his rulings): the source is `extensions/agent-question-ui/`, a
  subproject with its own `package.json` on the engines' Playground web app's toolchain (Vite, React 19, TypeScript,
  vitest with testing-library); one release script builds the bundle and deploys it into both packs'
  `extensions/agent-question/resources/public` (the Python checkout by its sibling path, an environment override),
  committed in both repositories, no source maps; each backend serves it from its own origin through the hosts' static
  content service ([[static-content-resources-public-node]], PR #138 and mercury-python #73), so no CORS; the published
  packages ship no extension. Three panels: the question-and-answer panel, the history with infinite scroll
  (`GET /questions?before=<seq>`, a backwards page beside the replay) and the transcript browser (`GET /transcripts`,
  `GET /transcripts/{conversation}` over the audit store) - useful to inspect what a chat, mail or topic channel
  delivered even when nobody answers here, since a topic has no convenient browser of its history. Sign-in `none` or
  `oauth2` only, `proxy` removed (the field's installations use 3-legged SSO and OAuth 2.0 access tokens): Authorization
  Code with PKCE in the browser against the issuer named by `GET /questions/config`, the bearer on every call, the
  stream read with `fetch` and `Last-Event-ID` since `EventSource` carries no bearer; a Keycloak development container
  and a mock issuer fixture for the tests; the Material Design `atom` icon of the engine docs (Apache-2.0) as the
  favicon and header mark; the vanilla page retired in both packs when the UI lands. Depends on the question record
  joining the audit log, which the backend reads (mercury-python thread `bp-question-record-and-ui`). Status: static
  content built and MERGED 2026-11-20 (PR #138); the question record's Node twin built and MERGED 2026-11-20 (PR #139; mercury-python #74
  MERGED); the backend's reads built and MERGED in both packs 2026-11-20 (PR #140, mercury-python #75: the history's
  pages, the transcript browser, the UI's config endpoint); the UI BUILT 2026-11-20 as PR #141 (the subproject - four
  panels including the Actuator menu, PKCE, the release script, the Keycloak development issuer, the device-side seen
  state - the bundle committed in both packs, mercury-python #76, and the vanilla page retired); DRIVEN LIVE 2026-11-20
  through both backends and a Keycloak issuer (mercury-composable `docs/test-reports/agent-question-ui-live-drive.md`):
  one host defect fixed in both packs ([[platform-on-shutdown-hook-node]]), two UI fixes; next the record-on-merge of
  #141 / mercury-python #76, then the reply page's own sign-in against the same issuer (a follow-up).
  → serves: vision-mercury-nodejs
  <!-- id: agent-question-react-ui | created: 2026-11-19 | last_used: 2026-11-19 | uses: 1 | tier: working | origin: 2026-11-19-094720 -->
