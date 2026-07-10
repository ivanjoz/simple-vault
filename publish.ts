import { rm } from 'node:fs/promises';

const outputDirectory = 'docs';

await rm(outputDirectory, { recursive: true, force: true });

console.log(`Building GitHub Pages site into ${outputDirectory}/...`);

const build = Bun.spawn(['bun', 'run', 'build'], {
	stdout: 'inherit',
	stderr: 'inherit'
});

const exitCode = await build.exited;

if (exitCode !== 0) {
	console.error(`Build failed with exit code ${exitCode}.`);
	process.exit(exitCode);
}

const requiredFiles = ['index.html', '404.html', 'CNAME', '.nojekyll'];
const missingFiles: string[] = [];

for (const file of requiredFiles) {
	if (!(await Bun.file(`${outputDirectory}/${file}`).exists())) {
		missingFiles.push(file);
	}
}

if (missingFiles.length > 0) {
	console.error(`Build is incomplete. Missing from ${outputDirectory}/: ${missingFiles.join(', ')}`);
	process.exit(1);
}

const domain = (await Bun.file(`${outputDirectory}/CNAME`).text()).trim();

if (domain !== 'vault.un.pe') {
	console.error(`Unexpected CNAME: ${domain || '(empty)'}`);
	process.exit(1);
}

console.log(`Published ${outputDirectory}/ for https://${domain}`);
