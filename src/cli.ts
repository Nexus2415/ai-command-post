#!/usr/bin/env node
// Usage:
//   node src/cli.ts status   — read Linear, report what's waiting, call no models
//   node src/cli.ts tick     — run one cycle
//   node src/cli.ts run      — run cycles every ACP_POLL_SECONDS until stopped

import { AGENTS } from "./agents.ts";
import { Budget } from "./budget.ts";
import { loadConfig } from "./config.ts";
import { DryRunStore, LinearStore, type TaskStore } from "./linear.ts";
import { tick, type Deps } from "./orchestrator.ts";
import { buildClients } from "./providers.ts";

async function main() {
  const cmd = process.argv[2] ?? "status";
  const cfg = loadConfig();
  if (!cfg.keys.linear) throw new Error("LINEAR_API_KEY is required");

  const real = new LinearStore(cfg.keys.linear);
  const store: TaskStore = cfg.dryRun ? new DryRunStore(real) : real;
  const clients = buildClients(cfg);
  const budget = new Budget({ capUsd: cfg.monthlyBudgetUsd, path: cfg.ledgerPath });

  const deps: Deps = {
    cfg: cmd === "status" ? { ...cfg, active: false } : cfg,
    store,
    clients,
    budget,
    log: (l) => console.log(l),
    toolEnv: (issue) => ({
      githubToken: cfg.keys.github,
      firecrawlKey: cfg.keys.firecrawl,
      vercelToken: cfg.keys.vercel,
      dryRun: cfg.dryRun,
      policy: { allowPullRequests: cfg.allowPullRequests, allowedRepos: cfg.githubRepos },
      comment: (body) => store.comment(issue.id, body),
      requestApproval: (reason, call) =>
        store.comment(issue.id, `**Owner approval needed**\n\n${reason}\n\nRequested: \`${call.tool}\`\n\nNothing was done. Reply here or change the task to proceed.`),
    }),
  };

  console.log(
    `AI Command Post — team ${cfg.linearTeamKey} · ${cfg.active ? "ACTIVE" : "off"} · ${cfg.dryRun ? "dry run" : "live writes"} · cap $${cfg.monthlyBudgetUsd}` +
      ` · agents online: ${Object.keys(clients).map((k) => AGENTS[k as keyof typeof AGENTS].name).join(", ") || "none"}`,
  );

  const once = async () => {
    const r = await tick(deps);
    if (store instanceof DryRunStore && store.log.length) {
      console.log("Dry-run writes:\n" + store.log.splice(0).map((l) => `  ${l}`).join("\n"));
    }
    return r;
  };

  if (cmd === "status" || cmd === "tick") {
    const r = await once();
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  if (cmd === "run") {
    let stop = false;
    process.on("SIGINT", () => (stop = true));
    process.on("SIGTERM", () => (stop = true));
    while (!stop) {
      try {
        await once();
      } catch (e) {
        console.error(`tick failed: ${(e as Error).message}`);
      }
      for (let s = 0; s < cfg.pollSeconds && !stop; s++) await new Promise((r) => setTimeout(r, 1000));
    }
    return;
  }
  throw new Error(`Unknown command "${cmd}". Use status, tick or run.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
