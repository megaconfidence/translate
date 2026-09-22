/**
 * The two calls the client makes to its own Worker.
 */

/** Enough to render the picker if /api/languages cannot be reached. */
const FALLBACK_LANGUAGES = { en: "English", es: "Spanish", fr: "French", de: "German" };

export async function fetchLanguages() {
	try {
		const response = await fetch("/api/languages");
		if (!response.ok) return FALLBACK_LANGUAGES;
		return (await response.json()).languages ?? FALLBACK_LANGUAGES;
	} catch {
		// Offline: the fallback list still lets the UI render.
		return FALLBACK_LANGUAGES;
	}
}

/** Resolves with the result, or throws with the server's message. */
export async function requestTranslation(image, target) {
	const response = await fetch("/api/translate", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ image, target }),
	});
	const payload = await response.json();
	if (!response.ok) {
		throw new Error(payload.error ?? `request failed (${response.status})`);
	}
	return payload;
}
