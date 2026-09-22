import {
	UpstreamError,
	runOcr,
	selectTranslatable,
	translateBlocks,
	type OcrBlock,
} from "./mistral";

/**
 * Upper bound on the incoming `data:` URL. The browser downscales before
 * upload, so a normal photo lands around 300-600 KB of base64; this only
 * exists to reject something pathological before we spend an API call on it.
 */
const MAX_IMAGE_CHARS = 12_000_000;

const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

/** Target languages the UI offers. Kept server-side so the API validates too. */
const TARGET_LANGUAGES: Record<string, string> = {
	en: "English",
	es: "Spanish",
	fr: "French",
	de: "German",
	it: "Italian",
	pt: "Portuguese",
	nl: "Dutch",
	ja: "Japanese",
	ko: "Korean",
	zh: "Chinese (Simplified)",
	ar: "Arabic",
	hi: "Hindi",
	tr: "Turkish",
	pl: "Polish",
	uk: "Ukrainian",
	ru: "Russian",
};

interface Region {
	id: number;
	type: string;
	box: { x: number; y: number; w: number; h: number };
	source: string;
	translated: string;
	/** False when the model gave us nothing for this id and we fell back. */
	translatedOk: boolean;
	confidence: number | null;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "no-store",
		},
	});
}

function logEvent(fields: Record<string, unknown>): void {
	console.log(JSON.stringify(fields));
}

function validateDataUrl(image: unknown): string {
	if (typeof image !== "string" || !image.startsWith("data:")) {
		throw new BadRequest("image must be a data: URL");
	}
	if (image.length > MAX_IMAGE_CHARS) {
		throw new BadRequest("image is too large; downscale before uploading");
	}
	const mime = image.slice(5, image.indexOf(";"));
	if (!ALLOWED_IMAGE_TYPES.includes(mime)) {
		throw new BadRequest(`unsupported image type "${mime}"`);
	}
	if (!image.includes(";base64,")) {
		throw new BadRequest("image must be base64 encoded");
	}
	return image;
}

class BadRequest extends Error {}

async function handleTranslate(request: Request, env: Env): Promise<Response> {
	const startedAt = Date.now();

	let body: any;
	try {
		body = await request.json();
	} catch {
		throw new BadRequest("body must be JSON");
	}

	const image = validateDataUrl(body?.image);
	const target = String(body?.target ?? "en");
	const targetName = TARGET_LANGUAGES[target];
	if (!targetName) throw new BadRequest(`unsupported target language "${target}"`);

	const ocrStarted = Date.now();
	const ocr = await runOcr(env.MISTRAL_API_KEY, env.OCR_MODEL, image);
	const ocrMs = Date.now() - ocrStarted;

	const translatable = selectTranslatable(ocr.blocks);
	if (translatable.length === 0) {
		logEvent({ message: "no text found", ocrMs, blocks: ocr.blocks.length });
		return json({
			width: ocr.width,
			height: ocr.height,
			detectedLanguage: "unknown",
			targetLanguage: target,
			regions: [],
			timings: { ocrMs, translateMs: 0, totalMs: Date.now() - startedAt },
		});
	}

	const translateStarted = Date.now();
	const translation = await translateBlocks(
		env.MISTRAL_API_KEY,
		env.TRANSLATE_MODEL,
		translatable,
		targetName,
	);
	const translateMs = Date.now() - translateStarted;

	// The join is by id we assigned, never by matching text. A translation that
	// changes the wording therefore cannot detach a box from its content.
	let missing = 0;
	const regions: Region[] = translatable.map(({ id, text, block }) => {
		const translated = translation.byId.get(id);
		if (translated === undefined) missing++;
		return {
			id,
			type: block.type,
			box: boxOf(block),
			source: text,
			translated: translated ?? text,
			translatedOk: translated !== undefined,
			confidence: block.confidence_scores?.average_content_confidence_score ?? null,
		};
	});

	logEvent({
		message: "translated",
		blocks: ocr.blocks.length,
		regions: regions.length,
		missing,
		detected: translation.detectedLanguage,
		target,
		ocrMs,
		translateMs,
	});

	return json({
		width: ocr.width,
		height: ocr.height,
		detectedLanguage: translation.detectedLanguage,
		targetLanguage: target,
		regions,
		timings: { ocrMs, translateMs, totalMs: Date.now() - startedAt },
	});
}

function boxOf(block: OcrBlock) {
	return {
		x: block.top_left_x,
		y: block.top_left_y,
		w: block.bottom_right_x - block.top_left_x,
		h: block.bottom_right_y - block.top_left_y,
	};
}

export default {
	async fetch(request, env, _ctx): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/api/languages") {
			return json({ languages: TARGET_LANGUAGES });
		}

		if (url.pathname === "/api/translate") {
			if (request.method !== "POST") {
				return json({ error: "method not allowed" }, 405);
			}
			try {
				return await handleTranslate(request, env);
			} catch (error) {
				if (error instanceof BadRequest) {
					return json({ error: error.message }, 400);
				}
				if (error instanceof UpstreamError) {
					console.error(
						JSON.stringify({
							message: "upstream failed",
							stage: error.stage,
							status: error.status,
							error: error.message,
						}),
					);
					// 4xx from the provider is usually our fault (bad key, bad
					// payload); surface it as 502 so the client sees one class
					// of "the pipeline broke" rather than a misleading 401.
					const status = error.status === 429 ? 429 : 502;
					return json({ error: error.message, stage: error.stage }, status);
				}
				console.error(
					JSON.stringify({
						message: "unhandled error",
						error: error instanceof Error ? error.message : String(error),
					}),
				);
				return json({ error: "internal error" }, 500);
			}
		}

		return json({ error: "not found" }, 404);
	},
} satisfies ExportedHandler<Env>;
