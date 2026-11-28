# ARN-174: Provider response qualification (source only)

Existing engine transport returned zero when metered token usage was missing, and Anthropic total input omitted cache creation/read. Metered responses now require explicit identity and valid bounded usage and preserve requested versus reported model. This is a provider observation, NOT gateway-authenticated settlement evidence, tariff binding or proof of safe paid execution. No API keys, calls, tariffs or default models changed. Tests use synthetic responses only.

## Official contracts reviewed 2026-11-28
- https://platform.claude.com/docs/en/api/messages/create and https://platform.claude.com/docs/en/build-with-claude/prompt-caching : input + cache creation + cache read; output includes provider billed output. Missing optional cache fields remain null, never proof of no cache charges.
- https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create : response identity, usage totals, cached/reasoning details. Preserve alias vs reported model; do not approve a paid tariff via alias alone.
- https://docs.perplexity.ai/docs/agent-api/migrate-from-sonar/overview : Sonar Chat Completions support ended September 27 2026; sync/stream calls progressively reformulated. Existing compatibility path is not a qualified paid pinned-model adapter. Agent/Search API protocol and all separately metered tools/fees need explicit qualification before activation.

Remaining: canonical independently authenticated egress receipt, exact approved tariff and model, conservative token and other charge limits, atomic reserve/settle/unknown, live authority and role verification. Legacy budget estimation is not atomic or a provider bill. Never activate from these tests. No Grok/Gemini routing.


### Reconciliation with main #160
Main 83e90a0 reintroduced implicit 429/529 retries based on an assumption that busy responses are always unbilled. This paid-qualification branch deliberately retains one transport request per admitted attempt for all metered providers, including those statuses. A later retry must have fresh explicit authorization/reservation and recheck stop/revocation; no hidden retries under one admission. No production configuration change or actual paid request is part of this PR.
