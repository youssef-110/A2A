#!/usr/bin/env node
// Minimal `runtime: command` agent. The client writes the delivered message as JSON on stdin;
// whatever this prints on stdout is sent back as the reply.
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const m = JSON.parse(input);
  process.stdout.write(`${m.to} received your ${m.kind}: "${m.text.slice(0, 200)}"`);
});
