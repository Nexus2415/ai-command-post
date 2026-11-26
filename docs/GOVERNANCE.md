# Arnexyia AI Governance: what's in place, what's missing

Checked 2026-11-26 by Claude at the owner's request ("verify that laws, ethical code of conduct and notables are in place; look at Anthropic, OpenAI, Grok and more"). Not legal advice; the items marked **lawyer** need one before the first paying client.

The rules themselves are in [CODE-OF-CONDUCT.md](CODE-OF-CONDUCT.md). This note is the evidence behind them.

## Bottom line

Arnexyia's safety controls are stronger than most small AI businesses': AIs can only read, every irreversible step needs Darius, spending is capped in code, there is a fail-closed off switch, and harmful requests are refused in code around every model. What was missing was one written code of conduct (now added) and a few rules that only matter **once AIs start talking to people outside Arnexyia** (sales email, calls, bids). Those are the gaps worth fixing, and they're all cheap if done before that channel is built.

## 1. What Arnexyia already has

| Control | Where | Status |
|---|---|---|
| Owner-only actions (merge, deploy, delete, buy, email, secrets, release gate) | `src/policy.ts` `RED_PATTERNS`; approval gate `api/_lib/workspace-actions.js` | In code, tested |
| Harm rules (violence, weapons, hacking, fraud, fake reviews, stalking, discrimination, drugs, child safety) on every message, tool call and reply | `HARM_RULES` in `src/policy.ts` + website copy, kept identical by `test/rules-gate.test.ts` | In code, tested |
| Stop everything switch, fails closed | `ws_control`, docs/WORKSPACE.md | Live |
| Spend caps: $15/month, $1/thread workspace; engine $0 and OFF | `ACP_WORKSPACE_*_BUDGET_USD`, `ACP_MONTHLY_BUDGET_USD` | Live |
| AIs can't act outward; only propose Linear issues/comments for owner approval | approval gate, 24h expiry, fingerprint | Live |
| Web content treated as untrusted data; no "open any address" tool | `web_read_page` rules, `test/web-access.test.ts` | Live |
| Audit trail: web activity under each reply, refusals logged, Linear history | workspace + Linear | Live |
| Eve runtime: dispatch unsupported, kill switch `ARNEXYIA_MULTI_AI_ACTIVE`, fail closed | opsdesk-harmony `internal/ai-command`, README here | In code |
| Client side: shadow mode first, green/yellow/red tiers, "never invent testimonials or outcomes", audit events, tenant isolation | opsdesk-harmony `/responsible-automation`, `/security`, `AGENTS.md` | Built; pages marked draft |
| Privacy, terms, MSA, DPA, SOW, retention, subprocessor drafts | opsdesk-harmony `/privacy`, `/terms`, `docs/legal/`, `docs/compliance/` | Drafts, **not lawyer-reviewed** |
| Security control map against OWASP/NIST agent risks | opsdesk-harmony `docs/security/agentic-security-control-map-2026-09-26.md` | Done |
| No client data in AI tools; `limited_live_ready=false` | project rules, AGENTS.md | Holding |
| Per-AI GitHub identities and signed provenance | ACP #121, #122, #123 | Merged |

## 2. Gaps, ranked by real risk to Arnexyia

"Matters now" = could cost money, a client or legal trouble in the next few months. "Later" = only once a feature exists. "Skip" = big-company boilerplate for Arnexyia's size.

| # | Gap | Risk | Smallest fix | Who |
|---|---|---|---|---|
| 1 | **No single written code of conduct** for the AIs; rules were spread over project instructions, CLAUDE.md files and code. | Matters now (low cost, high clarity) | `docs/CODE-OF-CONDUCT.md` | Done in this PR |
| 2 | **No AI-disclosure rule for outward messages.** California's B.O.T. Act (Bus. & Prof. Code §17940–17943) bars using an undisclosed bot to sell; Utah requires disclosure when asked (and up front for "high-risk" uses); the EU AI Act Art. 50 applies if anyone in the EU is contacted. Nothing outward exists yet, so no exposure today. | Later, but before any AI email/chat/voice reaches a prospect | Code of conduct §4.3 (done). When an outward channel is built: an "AI-assisted" line in the message and a truthful answer if someone asks. | Claude, with that feature |
| 3 | **AI phone calls and outreach.** The FCC ruled (Feb 2024) AI voices are "artificial" voices under the TCPA: calls need prior express consent, written for marketing. Cold email needs CAN-SPAM basics (real sender, address, opt-out). Fines are per call/message. | Later, high if ever started (an ElevenLabs connector is attached) | Rule: no AI-voice outbound calls or texts without written consent on file; email outreach only with opt-out and suppression list. Add both to the approval gate's red list when built. | Darius decides; Claude builds the check |
| 4 | **Bids and federal work (Nexus Federal Solutions).** AI-drafted bids with invented past performance, staff or certifications are false statements to the government (False Claims Act exposure). | Matters now if bids are being drafted | Code of conduct §2 and §4.1 (done): a person checks every factual claim and signs. Add a "facts checked by Darius" box to the bid checklist. | Darius |
| 5 | **Marketing claims ("AI washing").** The FTC's Operation AI Comply (2024–2026) keeps suing over unproven AI and earnings claims (e.g. Air AI) and over tools that produce fake reviews (Rytr). | Matters now for the public site and sales copy | opsdesk already blocks unsupported claims in generated public content. Before launch, re-read the public pages for any "guaranteed", "fully autonomous", savings or income numbers without evidence. | Claude can draft the review; Darius approves |
| 6 | **Model providers may keep or train on prompts.** Workspace calls go through OpenRouter and the code does not ask OpenRouter to skip providers that keep or train on data. Fine while there's no client data; not fine after. | Later (before any client data), cheap now | Account: in OpenRouter's privacy settings, turn off providers that may train on or retain inputs. Code (listed below): send OpenRouter's "deny data collection" provider preference on every call. | Darius (setting), Claude (code) |
| 7 | **Retention.** Workspace threads, files and notes are kept forever; opsdesk retention periods are still "TBD", and "nothing is deleted automatically". | Later (before client data) | Pick the periods in opsdesk `docs/compliance/retention-policy-proposal.md` with a lawyer; then a scheduled clean-up. | Darius + **lawyer** |
| 8 | **Legal drafts never reviewed.** Privacy, terms, MSA, DPA are all marked attorney-review drafts. | Matters before the first paying client | One fixed-fee lawyer review using `docs/legal/counsel-handoff-checklist.md`, which is already prepared. | Darius + **lawyer** |
| 9 | **Insurance.** No tech errors-and-omissions or cyber cover is on record. AI mistakes on a client's behalf are an E&O risk. | Before the first paying client | Get a quote; many small-business policies bundle both. | Darius |
| 10 | **AIs still comment in Linear as Darius.** Signatures can be forged, so "who approved" isn't provable there. GitHub now has per-AI identities. | Low now (one person), real once the engine runs | Already an open owner decision (claim provenance). Keep the rule: an AI's comment is never approval. | Darius decides |
| 11 | **Keyword harm net can be bypassed** by disguised wording. | Low, because workspace AIs can only read | Stated limit; the code of conduct makes the wider rule explicit. Consider a model-based second check only when outward actions exist. | Later |

### Big-company boilerplate Arnexyia can skip for now

- **Anthropic's Responsible Scaling Policy (v3.x), OpenAI's Preparedness Framework, frontier risk reports**: these govern companies that *train* frontier models. Arnexyia uses models; it doesn't build them.
- **EU AI Act high-risk duties** (now delayed to Dec 2027 / Aug 2028 by the 2026 Digital Omnibus): only for systems used in hiring, credit, education and similar decisions in the EU. Revisit only if Arnexyia sells into the EU.
- **Colorado AI Act** (original SB 24-205 repealed and replaced by SB 26-189, effective 2027-01-01) and **California CCPA automated-decision rules** (2027): these cover AI making "consequential decisions" about consumers (jobs, loans, housing, insurance) and, for California, businesses above the CCPA size thresholds. Arnexyia does neither. The code of conduct's discrimination rule covers the spirit.
- **Federal preemption fight** (Dec 2025 executive order, DOJ AI Litigation Task Force): state laws stay in force until a court or Congress says otherwise. Nothing to do.
- **ISO 42001 / SOC 2 / NIST AI RMF certification**: useful for selling to big clients later; the opsdesk security control map already uses NIST/OWASP as a reference, which is enough at this stage.

## 3. Code changes for Darius to approve (not made in this PR)

Each is small and would be its own PR. None loosens a safety default.

1. **OpenRouter privacy preference** (gap 6): add OpenRouter's provider preference that refuses providers which collect data, on every workspace call. Cost: none; a few models may become unavailable.
2. **Outward-channel red words** (gap 3): add phone call, text/SMS and "post to" patterns to `RED_PATTERNS` (engine and approval-gate copies, test keeps them identical). Today nothing can call or text, so this is belt-and-braces.
3. **Impersonation harm rule** (gap 2): refuse requests to "pretend to be a human" or "say you're not an AI" to someone outside Arnexyia. Tune to avoid catching role-play inside the workspace.
4. **Retention clean-up** (gap 7): after Darius picks periods, a daily job that deletes workspace files older than N days. Needs his choice of N.

## 4. Sources

Provider policies:
- Anthropic Usage Policy: https://www.anthropic.com/aup and the update note https://www.anthropic.com/news/usage-policy-update
- Anthropic Responsible Scaling Policy: https://www.anthropic.com/responsible-scaling-policy
- OpenAI Usage Policies: https://openai.com/policies/usage-policies/ ; change notice (effective 2026-11-20): https://help.openai.com/en/articles/12092907-were-updating-our-usage-policies
- OpenAI Model Spec: https://model-spec.openai.com (via https://openai.com/index/sharing-the-latest-model-spec/)
- xAI Acceptable Use Policy: https://x.ai/legal/acceptable-use-policy ; Enterprise terms (customer AUP duty): https://x.ai/legal/terms-of-service-enterprise

Law and regulators:
- EU AI Act Art. 50 and the 2026 Digital Omnibus: https://www.gibsondunn.com/eu-ai-act-omnibus-agreement-postponed-high-risk-deadlines-and-other-key-changes/ ; https://www.legalithm.com/en/blog/eu-ai-act-what-applies-2-august-2026
- Colorado SB 26-189 replacing SB 24-205: https://www.nortonrosefulbright.com/en/knowledge/publications/18733d31/colorado-enacts-revised-ai-law
- California CCPA automated-decision regulations: https://www.hunton.com/privacy-and-information-security-law/cppa-finalizes-ccpa-regulations-on-automated-decision-making-technology-risk-assessments-and-cybersecurity-audits
- Utah AI disclosure law (SB 149 as amended 2025): https://www.davispolk.com/insights/client-update/utah-scales-back-reach-generative-ai-consumer-protection-law
- State AI law overview (incl. California chatbot disclosure): https://www.cooley.com/news/insight/2026/2026-04-24-state-ai-laws-where-are-they-now
- FTC Operation AI Comply: https://www.ftc.gov/news-events/news/press-releases/2024/09/ftc-announces-crackdown-deceptive-ai-claims-schemes ; two-year update: https://www.hklaw.com/en/insights/publications/2026/08/operation-ai-comply-2-years-later-continued-enforcement
- FCC ruling on AI voices under the TCPA (Feb 2024): https://www.cooley.com/news/insight/2024/2024-02-15-fcc-ai-generated-robocalls-illegal-under-the-tcpa
- Federal executive order on state AI laws (Dec 2025): https://www.ropesgray.com/en/insights/alerts/2026/03/examining-the-landscape-and-limitations-of-the-federal-push-to-override-state-ai-regulation

Dates and status were checked through web search on 2026-11-26; secondary sources disagree on some dates (noted above). Confirm with a lawyer before relying on any one of them.
