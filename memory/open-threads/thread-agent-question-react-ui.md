- [ ] **(blueprint) The agent-question app's person's side as a small React app, maintained here for both packs (Eric,
  2026-11-19: "a useful tool for demo and real-world operation"; "putting it only in the mercury-nodejs language pack so
  there is one app to maintain in one place").** The page shipped with RFC-0014 step 3 is one vanilla HTML file the
  extension generates, byte-identical in both packs - cards grouped by case, a name field, the replay and the stream;
  on 2026-11-19 it gained a sticky header with the count of open cards, a *Waiting for you* section and a scrollable
  *History* panel that keeps its place while cards arrive. The upgrade: a small React app over the same three endpoints
  (`GET /questions?since`, `GET /questions/events`, `POST /questions/{id}/decide` and `/seen`) and the same message
  shape - cards as components (approval, question, advice), the waiting list and the history with search and filters (by
  case, state, who decided, time), a per-device cursor kept in local storage, the identity modes unchanged (`none`,
  `proxy`, `oauth2`) - built once and served by this extension's host at `/questions/app` as static files, so the
  Python pack's inbox is used from the same app (its README points here; its vanilla page stays as the fallback). Open
  before building: where the source lives (a `ui/` folder under the extension with its own `package.json`, the bundle
  committed or built in CI), the build step in CI, whether the Java Playground links to it, and whether a bundle in the
  published npm package is wanted or the app is run from the repository. Not started.
  → serves: vision-mercury-nodejs
  <!-- id: agent-question-react-ui | created: 2026-11-19 | last_used: 2026-11-19 | uses: 1 | tier: working | origin: 2026-11-19-094720 -->
