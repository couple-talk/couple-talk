// Run: node scripts/character-check.ts public/characters/<id>
// Same checks the app runs when a pack is imported or received from the partner.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { checkPack, type Files } from '../src/pack.ts';

const dir = process.argv[2];
if (!dir) { console.error('usage: node scripts/character-check.ts <pack dir>'); process.exit(2); }
const files: Files = {};
for (const f of readdirSync(dir)) if (statSync(join(dir, f)).isFile()) files[f] = readFileSync(join(dir, f));
const { errors, warnings } = await checkPack(files);
for (const w of warnings) console.warn('⚠️ ', w);
for (const e of errors) console.error('❌', e);
console.log(errors.length ? `불합격: 오류 ${errors.length}개` : `합격 (경고 ${warnings.length}개)`);
process.exit(errors.length ? 1 : 0);
