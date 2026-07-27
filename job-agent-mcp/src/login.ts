/**
 * Login helper — opens the dedicated profile in a plain Chrome process so you
 * can log in to sites manually. Login state persists in the profile and is
 * picked up by the agent's browser afterwards.
 *
 * Usage:
 *   npm run login                       # opens JOB_AGENT_HOME (or example.com)
 *   npm run login -- https://other.site
 *   CHROME_PATH=... npm run login       # explicit Chrome binary
 */
import { PROFILE_DIR, spawnChrome } from "./chrome.js";

const url = process.argv[2] ?? process.env.JOB_AGENT_HOME ?? "https://example.com";
const chrome = spawnChrome(url);

console.log(`Opened the dedicated profile in Chrome:`);
console.log(`  browser: ${chrome}`);
console.log(`  profile: ${PROFILE_DIR}`);
console.log(`  page:    ${url}`);
console.log(`\nComplete the login manually (QR code etc.).`);
console.log(`Login state is saved in the profile. Close the window when done.`);
