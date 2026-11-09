import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { checkShipped } from './generate-action-wording-audio.mjs';

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { checkShipped(); }
  catch (error) {
    console.error(`Action wording asset check failed (${error?.name === 'Error' ? error.message : 'Error'}).`);
    process.exitCode = 1;
  }
}
