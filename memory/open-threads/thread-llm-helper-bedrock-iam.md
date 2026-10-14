- [ ] **AWS Bedrock through IAM as the LLM helper's second backend.** The helper's backend seam is documented, not built:
  build the SDK's Bedrock client in `defaultBackend()` (it signs with the default AWS credential chain and takes a region, so
  there is no API key), prefix the model id in `providerModel()` (`anthropic.claude-opus-5-5`), report `supportsFallbacks: false`
  (server-side fallbacks are not offered on Bedrock), describe a missing AWS credential in `credentialProblem()`, and select it
  with `llm.backend: 'bedrock'`. The routes, the contract and the vector file stay as they are, and the Python twin does the
  same in `get_backend()`. Needs Eric's AWS account for the live drive, with a negative control first (a bad credential must fail
  by name).
  **Built 2026-10-14 (PR #111, the Python twin mercury-python #43):** the client, the prefix, the fallbacks flag, the credential
  and region checks, the docs and the vectors are in; what remains is the live drive - a wrong credential first - which this
  machine cannot run (no AWS access).
  → serves: vision-mercury-nodejs
  <!-- id: llm-helper-bedrock-iam | created: 2026-10-01 | last_used: 2026-10-01 | uses: 1 | tier: working | origin: 2026-10-02-001255 -->
