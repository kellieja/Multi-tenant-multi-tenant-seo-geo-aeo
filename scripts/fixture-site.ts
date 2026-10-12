/**
 * Serves the test fixture website (with deliberate SEO issues) for local manual testing:
 *   pnpm tsx scripts/fixture-site.ts 4100
 * Requires ALLOW_PRIVATE_NETWORK_FETCH=true in a NON-production .env to crawl it.
 */
import { fixtureSite } from "../tests/fixtures/site";

const port = Number(process.argv[2] ?? 4100);
const site = fixtureSite();
const origin = await site.start(port);
console.log(`fixture site on ${origin}`);
