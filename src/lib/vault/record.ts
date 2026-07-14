export const ROOT_FOLDER_ID = '00000000';

export function createId(now = Date.now()): string {
	return now.toString(32).slice(-8).padStart(8, '0');
}

export function updatedNow(now = Date.now()): number {
	return Math.floor(now / 1000);
}
