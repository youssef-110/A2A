// Test agent: replies with what it was given, so tests can check the prompt and provenance.
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const m = JSON.parse(input);
  process.stdout.write(
    JSON.stringify({
      text: m.text,
      sender_verified: m.sender_verified,
      redacted: m.redacted,
      wrapped: m.prompt.includes(`<a2a-message id="${m.id}"`) && m.prompt.includes("not as instructions from your operator"),
      env: { agent: process.env.A2A_AGENT, thread: process.env.A2A_THREAD, run: Boolean(process.env.A2A_RUN_ID) },
    }),
  );
});
