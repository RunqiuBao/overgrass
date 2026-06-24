#!/usr/bin/env node
// Quick environment check: is a TeX toolchain available for compilation?
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

async function has(cmd, args = ['--version']) {
  try {
    const { stdout } = await run(cmd, args);
    return stdout.split('\n')[0].trim();
  } catch {
    return null;
  }
}

const latexmk = await has('latexmk');
const pdflatex = await has('pdflatex');
const biber = await has('biber');

console.log('TeX environment check');
console.log('---------------------');
console.log(`latexmk : ${latexmk ?? 'NOT FOUND'}`);
console.log(`pdflatex: ${pdflatex ?? 'NOT FOUND'}`);
console.log(`biber   : ${biber ?? 'NOT FOUND'}`);

if (!latexmk) {
  console.log('\nlatexmk is required to compile. On Debian/Ubuntu:');
  console.log('  sudo apt-get install texlive-full latexmk');
  process.exit(1);
}
console.log('\nReady to compile ✓');
