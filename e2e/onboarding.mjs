// End-to-end smoke test driving system Chrome via puppeteer-core:
// onboarding → recovery key → lock/unlock → reload → recovery unlock, then
// CRUD (create → copy → edit → delete). Run against a preview server.

import puppeteer from 'puppeteer-core';

const URL = process.env.E2E_URL ?? 'http://localhost:4173';
const CHROME = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';
const PASSWORD = 'correct horse battery';

const log = (...a) => console.log('•', ...a);
const fail = (m) => {
	console.error('✗', m);
	process.exit(1);
};
const hasText = (page, t) =>
	page.waitForFunction((needle) => document.body.innerText.includes(needle), { timeout: 10000 }, t);

const browser = await puppeteer.launch({
	executablePath: CHROME,
	headless: 'new',
	args: ['--no-sandbox', '--disable-dev-shm-usage']
});

try {
	const page = await browser.newPage();
	// Headless Chrome denies real clipboard writes, so stub the OS-clipboard
	// boundary. This still exercises the full decrypt → copy → feedback path;
	// only the final syscall is mocked, and we capture what was written.
	await page.evaluateOnNewDocument(() => {
		const w = window;
		w.__clip = [];
		Object.defineProperty(navigator, 'clipboard', {
			configurable: true,
			value: {
				writeText: async (t) => {
					w.__clip.push(t);
				},
				readText: async () => w.__clip.at(-1) ?? ''
			}
		});
	});
	const errors = [];
	// Ignore benign noise: the favicon 404 and GIS's COOP window.closed warning.
	const benign = ['Failed to load resource', 'Cross-Origin-Opener-Policy'];
	page.on('console', (m) => {
		if (m.type() === 'error' && !benign.some((b) => m.text().includes(b))) errors.push(m.text());
	});
	page.on('pageerror', (e) => errors.push(String(e)));
	page.on('response', (r) => {
		if (r.status() === 404 && !r.url().endsWith('/favicon.ico')) errors.push(`404: ${r.url()}`);
	});

	await page.goto(URL, { waitUntil: 'networkidle0' });

	// --- Connect screen (use the local escape hatch; OAuth needs a real popup) --
	await hasText(page, 'stored encrypted in your Google Drive');
	await clickByText(page, 'button', 'Set up locally instead');
	log('connect screen shown; chose local setup');

	// --- Onboarding ----------------------------------------------------------
	await hasText(page, 'Create your vault');
	const pw = await page.$$('input[type="password"]');
	await pw[0].type(PASSWORD);
	await pw[1].type(PASSWORD);
	await clickByText(page, 'button', 'Create vault');

	await hasText(page, 'Save your recovery key');
	const recoveryKey = await page.evaluate(() => {
		const el = [...document.querySelectorAll('div')].find((d) =>
			/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(d.textContent?.trim() ?? '')
		);
		return el?.textContent?.trim() ?? null;
	});
	if (!recoveryKey) fail('recovery key not displayed');
	log('vault created, recovery key:', recoveryKey);
	await clickByText(page, 'button', 'Download recovery key');
	await clickByText(page, 'button', "I've saved it");
	await hasText(page, 'New item');
	log('unlocked after creation');

	// --- Lock / unlock -------------------------------------------------------
	await clickByText(page, 'button', 'Lock');
	await hasText(page, 'Unlock vault');
	await (await page.$('input[type="password"]')).type(PASSWORD);
	await clickByText(page, 'button', 'Unlock');
	await hasText(page, 'New item');
	log('unlocked with master password');

	// --- Stays unlocked across reload (session persistence, default on) ------
	await page.reload({ waitUntil: 'networkidle0' });
	await hasText(page, 'New item');
	log('stayed unlocked across reload (no re-type)');

	await clickByText(page, 'button', 'Lock');
	await hasText(page, 'Unlock vault');
	await (await page.$('input[type="password"]')).type('wrong password');
	await clickByText(page, 'button', 'Unlock');
	await hasText(page, 'Incorrect master password');
	log('wrong password rejected');

	// --- Reload persistence + recovery-key unlock ----------------------------
	await page.reload({ waitUntil: 'networkidle0' });
	await hasText(page, 'Unlock vault');
	await clickByText(page, 'button', 'Use recovery key instead');
	await (await page.$('input:not([type="password"])')).type(recoveryKey);
	await clickByText(page, 'button', 'Unlock');
	await hasText(page, 'New item');
	log('persisted across reload; unlocked with recovery key');

	// --- Create an item ------------------------------------------------------
	await clickByText(page, 'button', 'New item');
	await page.waitForSelector('[role="dialog"]');
	let inputs = await page.$$('[role="dialog"] input');
	await inputs[0].type('GitHub'); // title
	await inputs[1].type('octocat'); // username
	const passwordInput = await page.$('[role="dialog"] input.font-mono');
	const generated = await passwordInput.evaluate((el) => el.value);
	if (!generated) fail('password was not auto-generated');
	await clickByText(page, 'button', 'Save');
	await page.waitForFunction(
		() => [...document.querySelectorAll('div')].some((d) => d.textContent?.trim() === 'GitHub'),
		{ timeout: 10000 }
	);
	log('created item "GitHub" (generated password length ' + generated.length + ')');

	// --- Copy password -------------------------------------------------------
	await clickByText(page, 'button[title="Copy password"]', '');
	await hasText(page, 'Copied');
	const clip = await page.evaluate(() => window.__clip.at(-1));
	if (clip !== generated) fail(`clipboard mismatch: got "${clip}"`);
	log('one-click copy wrote the correct decrypted password');

	// --- Edit ----------------------------------------------------------------
	await clickByTextExact(page, '.cursor-pointer', 'GitHub');
	await page.waitForSelector('[role="dialog"]');
	inputs = await page.$$('[role="dialog"] input');
	await inputs[0].click();
	await page.keyboard.down('Control');
	await page.keyboard.press('KeyA');
	await page.keyboard.up('Control');
	await page.keyboard.press('Backspace');
	await inputs[0].type('GitHub Renamed');
	await clickByText(page, 'button', 'Save');
	await page.waitForFunction(
		() =>
			[...document.querySelectorAll('div')].some((d) => d.textContent?.trim() === 'GitHub Renamed'),
		{ timeout: 10000 }
	);
	log('edited item title');

	// --- Delete --------------------------------------------------------------
	await clickByTextExact(page, '.cursor-pointer', 'GitHub Renamed');
	await page.waitForSelector('[role="dialog"]');
	await clickByText(page, 'button', 'Delete');
	await hasText(page, 'Your vault is empty');
	log('deleted item; vault empty');

	// --- Change master password (DEK rotation) -------------------------------
	await clickByText(page, 'button[title="Settings"]', '');
	await hasText(page, 'Change master password');
	const spw = await page.$$('[role="dialog"] input[type="password"]');
	await spw[0].type('brand new password');
	await spw[1].type('brand new password');
	await clickByText(page, 'button', 'Change password');
	await hasText(page, 'Master password changed');
	await clickByText(page, 'button', 'Close');
	log('changed master password (DEK rotated)');

	await clickByText(page, 'button', 'Lock');
	await hasText(page, 'Unlock vault');
	await (await page.$('input[type="password"]')).type('brand new password');
	await clickByText(page, 'button', 'Unlock');
	await hasText(page, 'New item');
	log('unlocked with the new master password');

	if (errors.length) fail('console/page errors:\n' + errors.join('\n'));
	console.log('\n✓ ALL E2E CHECKS PASSED');
} finally {
	await browser.close();
}

async function clickByText(page, selector, text) {
	const handle = await page.evaluateHandle(
		(sel, t) => [...document.querySelectorAll(sel)].find((el) => (t ? el.textContent?.includes(t) : true)),
		selector,
		text
	);
	const el = handle.asElement();
	if (!el) throw new Error(`no ${selector} with text "${text}"`);
	await el.click();
}

async function clickByTextExact(page, selector, text) {
	const handle = await page.evaluateHandle(
		(sel, t) => [...document.querySelectorAll(sel)].find((el) => el.textContent?.includes(t)),
		selector,
		text
	);
	const el = handle.asElement();
	if (!el) throw new Error(`no ${selector} containing "${text}"`);
	await el.click();
}
