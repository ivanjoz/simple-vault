// Trigger a client-side text download (used for the recovery key file).

export function downloadText(filename: string, text: string): void {
	downloadBlob(filename, new Blob([text], { type: 'text/plain;charset=utf-8' }));
}

export function downloadBytes(filename: string, bytes: Uint8Array): void {
	downloadBlob(filename, new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/cbor' }));
}

function downloadBlob(filename: string, blob: Blob): void {
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	URL.revokeObjectURL(url);
}
