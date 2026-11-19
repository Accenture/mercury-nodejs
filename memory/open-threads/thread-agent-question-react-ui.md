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
  here; the vanilla page of both backends stays as the fallback. Open before building: where the source lives (a `ui/`
  folder under the extension with its own `package.json`, the bundle committed or built in CI), how a backend serves the
  bundle (a static folder both twins serve, or the generated page replaced), CORS for a front-end hosted apart, whether
  the Java Playground links to it, and whether the bundle ships in the published npm package or the front-end is run from
  the repository. Not started.
  → serves: vision-mercury-nodejs
  <!-- id: agent-question-react-ui | created: 2026-11-19 | last_used: 2026-11-19 | uses: 1 | tier: working | origin: 2026-11-19-094720 -->
