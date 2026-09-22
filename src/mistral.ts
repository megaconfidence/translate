/**
 * Mistral Document AI + chat calls.
 *
 * Measured behaviour this module relies on (probed against mistral-ocr-latest
 * on 2026-09-21, see README notes):
 *  - `image_url` accepts a `data:` URL, so the image never needs to be hosted.
 *  - `include_blocks` works on single-image input; the image counts as one page.
 *  - Block coordinates are INTEGER PIXELS in the coordinate space of the image
 *    that was submitted, and `page.dimensions` echoes that image's size exactly.
 *    Overlay maths therefore needs no DPI conversion, only a display scale.
 */

const MISTRAL_API = "https://api.mistral.ai/v1";
const OCR_TIMEOUT_MS = 60_000;
const CHAT_TIMEOUT_MS = 60_000;

export interface OcrBlock {
	type: string;
	top_left_x: number;
	top_left_y: number;
	bottom_right_x: number;
	bottom_right_y: number;
	content: string | null;
	confidence_scores?: {
		average_content_confidence_score: number | null;
		minimum_content_confidence_score: number | null;
		block_type_confidence_score: number | null;
	} | null;
}

export interface OcrResult {
	width: number;
	height: number;
	blocks: OcrBlock[];
}

/** Block types that are never worth translating or drawing over. */
const SKIPPED_BLOCK_TYPES = new Set(["image", "signature", "code", "equation"]);

export class UpstreamError extends Error {
	constructor(
		readonly stage: "ocr" | "translate",
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "UpstreamError";
	}
}

async function postJson(
	path: string,
	apiKey: string,
	body: unknown,
	timeoutMs: number,
	stage: "ocr" | "translate",
): Promise<any> {
	let response: Response;
	try {
		response = await fetch(`${MISTRAL_API}${path}`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (error) {
		const timedOut = error instanceof Error && error.name === "TimeoutError";
		throw new UpstreamError(
			stage,
			timedOut ? 504 : 502,
			timedOut ? `${stage} request timed out` : `${stage} request failed`,
		);
	}

	if (!response.ok) {
		// Body may carry a useful provider message; cap it so we never log a wall of text.
		const detail = (await response.text().catch(() => "")).slice(0, 300);
		throw new UpstreamError(
			stage,
			response.status,
			`${stage} returned ${response.status}: ${detail}`,
		);
	}
	return response.json();
}

/**
 * OCR strips layout into positioned blocks. The returned width/height are the
 * dimensions of the submitted image, which is what block coordinates are
 * relative to.
 */
export async function runOcr(
	apiKey: string,
	model: string,
	imageDataUrl: string,
): Promise<OcrResult> {
	const data = await postJson(
		"/ocr",
		apiKey,
		{
			model,
			document: { type: "image_url", image_url: imageDataUrl },
			include_blocks: true,
			confidence_scores_granularity: "block",
		},
		OCR_TIMEOUT_MS,
		"ocr",
	);

	const page = data?.pages?.[0];
	if (!page) throw new UpstreamError("ocr", 502, "OCR returned no pages");

	const width = Number(page.dimensions?.width);
	const height = Number(page.dimensions?.height);
	if (!width || !height) {
		throw new UpstreamError("ocr", 502, "OCR returned no page dimensions");
	}

	// `blocks` is null unless the model is OCR 4+. Fail loudly rather than
	// silently rendering an empty overlay.
	if (!Array.isArray(page.blocks)) {
		throw new UpstreamError(
			"ocr",
			502,
			`model "${model}" returned no blocks; block extraction needs OCR 4 or newer`,
		);
	}

	return { width, height, blocks: page.blocks as OcrBlock[] };
}

/**
 * OCR emits markdown, so a heading arrives as "## Entrantes" and an emphasised
 * line as "*Cocina tradicional*". Those markers are layout artefacts, not text
 * the user photographed, so they are removed before translation and drawing.
 */
export function stripMarkdown(raw: string): string {
	return raw
		.split("\n")
		.map((line) =>
			line
				.replace(/^\s{0,3}#{1,6}\s+/, "")
				.replace(/^\s{0,3}[-*+]\s+/, "")
				.replace(/^\s{0,3}>\s?/, "")
				.replace(/\*\*(.+?)\*\*/g, "$1")
				.replace(/(^|[^*])\*([^*]+)\*/g, "$1$2")
				.replace(/__(.+?)__/g, "$1")
				.replace(/`([^`]+)`/g, "$1")
				.trim(),
		)
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
}

/** A block that survived filtering and is worth sending to the translator. */
export interface TranslatableBlock {
	id: number;
	text: string;
	block: OcrBlock;
}

export function selectTranslatable(blocks: OcrBlock[]): TranslatableBlock[] {
	const out: TranslatableBlock[] = [];
	for (const block of blocks) {
		if (SKIPPED_BLOCK_TYPES.has(block.type)) continue;
		const text = stripMarkdown(block.content ?? "");
		if (!text) continue;
		// Boxes with no area cannot be drawn into.
		if (block.bottom_right_x <= block.top_left_x) continue;
		if (block.bottom_right_y <= block.top_left_y) continue;
		out.push({ id: out.length, text, block });
	}
	return out;
}

export interface TranslationResult {
	detectedLanguage: string;
	/** id -> translated text. Missing ids mean the model dropped that block. */
	byId: Map<number, string>;
}

const TRANSLATION_SCHEMA = {
	type: "json_schema",
	json_schema: {
		name: "translation",
		strict: true,
		schema: {
			type: "object",
			properties: {
				detected_language: {
					type: "string",
					description:
						"ISO 639-1 code of the dominant source language, lowercase, e.g. 'es'.",
				},
				items: {
					type: "array",
					items: {
						type: "object",
						properties: {
							id: { type: "integer" },
							translated: { type: "string" },
						},
						required: ["id", "translated"],
						additionalProperties: false,
					},
				},
			},
			required: ["detected_language", "items"],
			additionalProperties: false,
		},
	},
} as const;

/**
 * Every block goes in one request. Sending them together is both faster and
 * more accurate than per-block calls: short menu fragments are ambiguous alone,
 * and the surrounding lines give the model the context to resolve them.
 */
export async function translateBlocks(
	apiKey: string,
	model: string,
	items: TranslatableBlock[],
	targetLanguage: string,
): Promise<TranslationResult> {
	const payload = items.map(({ id, text }) => ({ id, text }));

	const data = await postJson(
		"/chat/completions",
		apiKey,
		{
			model,
			temperature: 0.2,
			max_tokens: 4000,
			response_format: TRANSLATION_SCHEMA,
			messages: [
				{
					role: "system",
					content: [
						`You translate text extracted from a photograph into ${targetLanguage}.`,
						"The items together form one document, so use the surrounding items as context.",
						"Rules:",
						"- Return exactly one entry for every id you were given. Never add or drop ids.",
						"- Keep numbers, prices, currency symbols and proper nouns unchanged.",
						"- Keep translations roughly as short as the source; they are drawn into a fixed box.",
						`- If an item is already in ${targetLanguage}, repeat it unchanged.`,
						"- Return only the translation, never an explanation or transliteration.",
					].join("\n"),
				},
				{ role: "user", content: JSON.stringify({ items: payload }) },
			],
		},
		CHAT_TIMEOUT_MS,
		"translate",
	);

	const content = data?.choices?.[0]?.message?.content;
	// Reasoning models return an array of content blocks rather than a string,
	// so pull out the text parts before parsing.
	const text =
		typeof content === "string"
			? content
			: Array.isArray(content)
				? content
						.filter((part: any) => part?.type === "text")
						.map((part: any) => part.text)
						.join("")
				: "";

	if (!text.trim()) {
		throw new UpstreamError("translate", 502, "translation returned empty content");
	}

	let parsed: any;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new UpstreamError("translate", 502, "translation was not valid JSON");
	}

	const byId = new Map<number, string>();
	for (const entry of parsed?.items ?? []) {
		const id = Number(entry?.id);
		const translated = entry?.translated;
		if (Number.isInteger(id) && typeof translated === "string") {
			byId.set(id, translated);
		}
	}

	return {
		detectedLanguage:
			typeof parsed?.detected_language === "string"
				? parsed.detected_language
				: "unknown",
		byId,
	};
}
