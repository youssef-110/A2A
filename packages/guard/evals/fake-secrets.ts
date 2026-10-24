/**
 * Fake credentials for tests, evals and the demo. They are assembled at runtime so that no
 * key-shaped string is committed (GitHub push protection and secret scanners would flag them).
 * None of these are, or ever were, real credentials.
 */
export const FAKE = {
  stripe: ["sk", "live", "51Hc8dKJdk2l3mXyZaBcDeFgH"].join("_"),
  aws: ["AKIA", "IOSFODNN7", "EXAMPLE"].join(""),
  github: ["ghp", "aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789ab"].join("_"),
  slack: ["xoxb", "2048", "99887766", "abcdefghijk"].join("-"),
  apiKey: ["Zx81kLmQ0p", "Rt7vYw2bNc"].join(""),
} as const;

/** Replaces {{FAKE_STRIPE}}-style placeholders with the values above. */
export function fillFakeSecrets(text: string): string {
  return text
    .replaceAll("{{FAKE_STRIPE}}", FAKE.stripe)
    .replaceAll("{{FAKE_AWS}}", FAKE.aws)
    .replaceAll("{{FAKE_GITHUB}}", FAKE.github)
    .replaceAll("{{FAKE_SLACK}}", FAKE.slack)
    .replaceAll("{{FAKE_API_KEY}}", FAKE.apiKey);
}
