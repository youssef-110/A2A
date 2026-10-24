import { parseArgs } from "node:util";
import { resolve } from "node:path";
import type { JudgeMode } from "@a2a/guard";
import { startRelay } from "./index.ts";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: process.env.A2A_PORT ?? "7700" },
    host: { type: "string", default: process.env.A2A_HOST ?? "127.0.0.1" },
    data: { type: "string", default: process.env.A2A_DATA ?? ".a2a-relay" },
    policy: { type: "string" },
    judge: { type: "string", default: process.env.A2A_JUDGE },
    name: { type: "string", default: process.env.A2A_RELAY_NAME ?? "a2a-relay" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(`Usage: a2a-relay [--port 7700] [--host 127.0.0.1] [--data .a2a-relay] [--policy examples/policy.yaml] [--judge auto|anthropic|claude-cli|heuristic|off]

  --policy is only read on first start. After that the policy lives in the database and is edited in the console.
  The admin token is A2A_ADMIN_TOKEN, or generated into <data>/admin-token.`);
  process.exit(0);
}

const stamp = (): string => new Date().toISOString().slice(11, 19);
const running = await startRelay({
  dataDir: resolve(values.data!),
  port: Number(values.port),
  host: values.host,
  policyPath: values.policy ? resolve(values.policy) : undefined,
  judge: values.judge as JudgeMode | undefined,
  name: values.name,
  log: (m) => console.log(`${stamp()} ${m}`),
});

const j = running.relay.judgeInfo();
console.log(`A2A relay listening on ${running.url}
  console      ${running.url}/
  org          ${running.relay.policy.org} (policy v${running.relay.policyVersion})
  guard judge  ${j.kind}: ${j.fast}${j.strong ? `, escalates to ${j.strong}` : ""}
  data         ${resolve(values.data!)}
  admin token  ${running.adminToken}`);

let closing = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    if (closing) process.exit(1);
    closing = true;
    console.log("shutting down");
    await running.close();
    process.exit(0);
  });
}
