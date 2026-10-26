import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Daemon } from "../packages/client/src/daemon.ts";
import { joinNetwork } from "../packages/client/src/join.ts";
import { loadConfig } from "../packages/client/src/config.ts";
import { detectTools, installTool } from "../packages/client/src/tools.ts";
import { sameOrigin } from "../packages/client/src/connect.ts";
import { adminFetch, cleanup, relay, tempDir, waitFor } from "./helpers.ts";

const policy = (org: string): string =>
  `org: ${org}\nregistration: invite\nisolation: sessions\nscopes:\n  general:\n    description: Anything.\nrules:\n  block: []\n  hold: []\n  redact: []\nguard:\n  judge: off\n`;

test("one computer in two workspaces: one client, both relays, names resolve across them", async () => {
  const dir = tempDir("multi-policy");
  writeFileSync(join(dir, "a.yaml"), policy("alpha"));
  writeFileSync(join(dir, "b.yaml"), policy("beta"));
  const a = await relay({ policyPath: join(dir, "a.yaml"), judges: null });
  const b = await relay({ policyPath: join(dir, "b.yaml"), judges: null });
  const [me, ana, ben] = [tempDir("multi-me"), tempDir("multi-ana"), tempDir("multi-ben")];
  const daemons: Daemon[] = [];
  try {
    // I own nothing here: I'm a guest in a session on each relay; Ana and Ben own their relays.
    const sesA = (await adminFetch(a.url, "POST", "/v1/admin/sessions", { name: "Alpha launch" })).body as { invite: { url: string } };
    const sesB = (await adminFetch(b.url, "POST", "/v1/admin/sessions", { name: "Beta launch" })).body as { invite: { url: string } };
    await joinNetwork(me, sesA.invite.url, { name: "sam" });
    await joinNetwork(me, sesB.invite.url, { name: "sam" });
    await joinNetwork(ana, ((await adminFetch(a.url, "POST", "/v1/admin/invites", { owner: true })).body as { url: string }).url, { name: "ana" });
    await joinNetwork(ben, ((await adminFetch(b.url, "POST", "/v1/admin/invites", { owner: true })).body as { url: string }).url, { name: "ben" });

    const cfg = loadConfig(me);
    assert.equal(cfg.agents.length, 2);
    assert.equal(cfg.networks?.length, 1, "the second relay is added next to the first, with its own pinned key");

    for (const home of [me, ana, ben]) {
      const d = new Daemon({ home, log: () => {} });
      await d.start();
      daemons.push(d);
    }
    await waitFor(() => daemons.every((d) => (d.info().relays as { connected: boolean }[]).every((r) => r.connected)), 5000, "all relays connected");

    // By name, each message goes out from the agent that can reach the person.
    const toBen = await daemons[0]!.send({ to: "ben", text: "hello from beta's guest" }, 0);
    const toAna = await daemons[0]!.send({ to: "ana", text: "hello from alpha's guest" }, 0);
    assert.notEqual(toBen.state, "blocked");
    assert.notEqual(toAna.state, "blocked");
    const got = async (d: Daemon, agent: string) => (await d.nextInbox([agent], 5000))?.text;
    assert.equal(await got(daemons[2]!, "agent://beta/ben"), "hello from beta's guest");
    assert.equal(await got(daemons[1]!, "agent://alpha/ana"), "hello from alpha's guest");
    const reach = (await daemons[0]!.reachable()).map((d) => d.address).filter((x) => !x.endsWith("/console")).sort();
    assert.deepEqual(reach, ["agent://alpha/ana", "agent://beta/ben"]);
    // Sessions from both relays, with the workspace each is in.
    const sessions = (await daemons[0]!.sessions()).map((s) => `${s.workspace}:${s.name}`).sort();
    assert.deepEqual(sessions, ["alpha:Alpha launch", "beta:Beta launch"]);

    // Deleting the session on beta tells my client.
    const list = (await adminFetch(b.url, "GET", "/v1/admin/sessions")).body as { sessions: { id: string }[] };
    await adminFetch(b.url, "DELETE", `/v1/admin/sessions/${list.sessions[0]!.id}`);
    await waitFor(() => daemons[0]!.takeNotices(["agent://beta/sam"]).length === 1, 5000, "session deleted notice");
  } finally {
    for (const d of daemons) await d.stop();
    await a.close();
    await b.close();
    cleanup(a.dataDir, b.dataDir, dir, me, ana, ben);
  }
});

test("connect writes the a2a MCP server into each app's own config format without touching the rest", () => {
  const apps = tempDir("apps");
  const old = process.env.A2A_APPS_HOME;
  process.env.A2A_APPS_HOME = apps;
  try {
    mkdirSync(join(apps, ".gemini", "antigravity"), { recursive: true });
    writeFileSync(join(apps, ".gemini", "antigravity", "mcp_config.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    mkdirSync(join(apps, ".codex"), { recursive: true });
    writeFileSync(join(apps, ".codex", "config.toml"), 'model = "o4"\n\n[mcp_servers."a2a"]\ncommand = "old"\nargs = [\n  ["a", "b"],\n]\n\n[mcp_servers.other]\ncommand = "keep"\n');
    mkdirSync(join(apps, ".cursor"), { recursive: true });
    assert.deepEqual(detectTools().map((t) => t.id).sort(), ["antigravity", "codex", "cursor"]);

    const mcp = { command: "node", args: ["/home/sam/.a2a/bin/a2a.mjs", "mcp"] };
    for (const id of ["antigravity", "codex", "cursor"]) assert.ok(installTool(id, mcp).ok);

    const ag = JSON.parse(readFileSync(join(apps, ".gemini", "antigravity", "mcp_config.json"), "utf8"));
    assert.deepEqual(ag.mcpServers.other, { command: "x" });
    assert.deepEqual(ag.mcpServers.a2a.args, ["/home/sam/.a2a/bin/a2a.mjs", "mcp", "--tool", "antigravity"]);
    assert.match(readFileSync(join(apps, ".gemini", "antigravity", "skills", "a2a", "SKILL.md"), "utf8"), /name: a2a/);
    const toml = readFileSync(join(apps, ".codex", "config.toml"), "utf8");
    assert.equal(toml.match(/\[mcp_servers\."?a2a"?\]/g)?.length, 1);
    assert.doesNotMatch(toml, /"old"/);
    assert.match(toml, /\[mcp_servers\.other\]\ncommand = "keep"/);
    assert.match(toml, /args = \["\/home\/sam\/.a2a\/bin\/a2a.mjs", "mcp", "--tool", "codex"\]/);
    assert.equal(JSON.parse(readFileSync(join(apps, ".cursor", "mcp.json"), "utf8")).mcpServers.a2a.command, "node");
  } finally {
    if (old === undefined) delete process.env.A2A_APPS_HOME;
    else process.env.A2A_APPS_HOME = old;
    cleanup(apps);
  }
});

test("the sign-in token only goes to the exact site it came from", () => {
  assert.ok(sameOrigin("https://a2a-relay.a2a-cloud.workers.dev/w/acme", "https://a2a-relay.a2a-cloud.workers.dev"));
  assert.equal(sameOrigin("https://a2a-relay.a2a-cloud.workers.dev.evil.com/w/acme", "https://a2a-relay.a2a-cloud.workers.dev"), false);
  assert.equal(sameOrigin("http://a2a-relay.a2a-cloud.workers.dev/w/acme", "https://a2a-relay.a2a-cloud.workers.dev"), false);
});
