# Changelog

## 0.1.0 (unreleased)

- Primitive in-process event bus - the single dispatch pipeline: one FIFO mailbox per
  route consumed by `instances` worker loops (the parameter is faithful); RPC deliveries
  are ttl-bounded with a dead-work skip; drop-n-forget returns the 202-shape ack. The
  HTTP host and the local side of PostOffice are thin ingress adapters over it. No spill
  tier and no queue cap by design - back-pressure belongs to the engines' flows/graphs;
  a leaf host fails fast by deadline. An in-flight RPC holds the process open (at most
  until its deadline); an idle bus holds nothing.
- PostOffice without an endpoint delivers locally (engine semantics): private routes are
  callable in-app while the wire keeps its 403; headers pass verbatim; the reply envelope
  shape is identical to the remote path.

Repository repurposed for the Mercury Composable **polyglot initiative** (August 2026):
instead of re-porting the full composable foundation, the fresh start is a lightweight
wrapper of the engines' Event-over-HTTP protocol.

- Lightweight Event-over-HTTP function host (`POST /api/event`) mirroring the engines'
  EventApiService semantics (x-ttl execution bound, x-async drop-n-forget with 202 ack,
  reserved header hygiene, `my_cid` → `my_correlation_id` injection, portable error
  contract, engine-identical error messages).
- Standard event envelope wire format codec, verified against the golden conformance
  vectors shared with the Java and Rust engines; compact format detected and rejected;
  int64 beyond 2^53 kept exact as BigInt.
- `preload()` function registry with instance-count concurrency limits and private routes.
- `PostOffice` thin client with the engines' relay HTTP contract (octet-stream, x-ttl,
  x-no-stream, trace headers) for calling engine or peer polyglot functions.
- Minimalist utilities in engine-consistent style: `AppConfig` (`${ENV:default}`
  substitution, runtime overrides), logging in the reference log4j2 presentation
  (`log.format=text|json`, `LOG_LEVEL`), and distributed-trace context (AsyncLocalStorage)
  with reply annotations.
- `mercury-serve` developer runner.

The previous Node.js port of the full framework (up to v4.3.28) remains available in the
git history.
