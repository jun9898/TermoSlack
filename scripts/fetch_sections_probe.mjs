import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const { fetchChannelSectionsRaw, normalizeChannelSections } = await import('../src/sections.js');

const result = await fetchChannelSectionsRaw();

if (result.skipped) {
  console.log(`SKIPPED: ${result.reason}`);
  process.exit(1);
}

console.log(`=== HTTP status ===\n${result.status}\n`);

console.log('=== RAW BODY ===');
if (result.payload) {
  console.log(JSON.stringify(result.payload, null, 2));
} else {
  console.log(result.text);
  console.log(`\n(JSON parse failed: ${result.parseError && result.parseError.message})`);
}

console.log('\n=== NORMALIZED ===');
console.log(JSON.stringify(normalizeChannelSections(result.payload), null, 2));
