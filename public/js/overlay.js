/**
 * Everything that draws translations onto the photo.
 *
 * Geometry contract: OCR block coordinates are pixels in the space of the image
 * we uploaded, and the frame is locked to that image's aspect ratio. Positions
 * are therefore a pure percentage mapping with no scaling maths.
 */

import { el } from "./ui.js";

/** Used when a region's colour cannot be sampled. */
const FALLBACK_COLOR = { bg: "#ffffff", fg: "#10151c" };

/** Fraction of a box's short side read as background rather than glyphs. */
const EDGE_SAMPLE_RATIO = 0.18;
/** Above this perceptual luminance the chip needs dark text. */
const LIGHT_BACKGROUND_LUMINANCE = 0.55;
/** OCR confidence below this gets a visible warning underline. */
const LOW_CONFIDENCE = 0.7;

/** Starting font size as a fraction of the box height. */
const FONT_HEIGHT_RATIO = 0.74;
/** Multiplier applied each time the text still does not fit. */
const SHRINK_STEP = 0.9;
/** Below this the text stops being readable, so we clip instead of shrinking. */
const MIN_FONT_PX = 5;
/** Canvas needs a slightly larger floor than the DOM to stay legible. */
const MIN_CANVAS_FONT_PX = 7;

/** Set by render(); the ResizeObserver and compose() both need it. */
let rendered = null;

/* ------------------------------------------------------------ colour match */

/**
 * Sample each box's background straight from the photo so the chip sits in the
 * image instead of on top of it. Only the box's outer rim is read: the middle
 * is mostly glyphs, the rim is mostly background.
 */
function sampleColors(bitmap, regions) {
	const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
	const ctx = canvas.getContext("2d", { willReadFrequently: true });
	ctx.drawImage(bitmap, 0, 0);

	return regions.map(({ box }) => {
		const x = Math.max(0, Math.min(box.x, bitmap.width - 1));
		const y = Math.max(0, Math.min(box.y, bitmap.height - 1));
		const w = Math.max(1, Math.min(box.w, bitmap.width - x));
		const h = Math.max(1, Math.min(box.h, bitmap.height - y));

		let pixels;
		try {
			pixels = ctx.getImageData(x, y, w, h).data;
		} catch {
			return FALLBACK_COLOR;
		}

		const rim = Math.max(1, Math.round(Math.min(w, h) * EDGE_SAMPLE_RATIO));
		let red = 0;
		let green = 0;
		let blue = 0;
		let counted = 0;

		for (let row = 0; row < h; row++) {
			const onHorizontalRim = row < rim || row >= h - rim;
			for (let col = 0; col < w; col++) {
				const onVerticalRim = col < rim || col >= w - rim;
				if (!onHorizontalRim && !onVerticalRim) continue;
				const i = (row * w + col) * 4;
				red += pixels[i];
				green += pixels[i + 1];
				blue += pixels[i + 2];
				counted++;
			}
		}
		if (!counted) return FALLBACK_COLOR;

		red = Math.round(red / counted);
		green = Math.round(green / counted);
		blue = Math.round(blue / counted);

		const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
		return {
			bg: `rgb(${red} ${green} ${blue})`,
			fg: luminance > LIGHT_BACKGROUND_LUMINANCE ? FALLBACK_COLOR.fg : "#ffffff",
		};
	});
}

/* ---------------------------------------------------------------- rendering */

export function render(result, bitmap, onRegionTap) {
	const colors = sampleColors(bitmap, result.regions);
	rendered = { result, colors };

	const nodes = result.regions.map((region, index) => {
		const color = colors[index] ?? FALLBACK_COLOR;
		const node = document.createElement("div");
		node.className = "region";
		if (region.type === "title") node.classList.add("is-title");
		if (region.confidence !== null && region.confidence < LOW_CONFIDENCE) {
			node.classList.add("is-low");
		}

		node.style.left = `${(region.box.x / result.width) * 100}%`;
		node.style.top = `${(region.box.y / result.height) * 100}%`;
		node.style.width = `${(region.box.w / result.width) * 100}%`;
		node.style.height = `${(region.box.h / result.height) * 100}%`;
		node.style.background = color.bg;
		node.style.color = color.fg;
		node.style.animationDelay = `${Math.min(index * 18, 320)}ms`;

		const span = document.createElement("span");
		span.textContent = region.translated;
		node.append(span);
		node.addEventListener("click", () => onRegionTap(region, node));
		return node;
	});

	el.overlay.replaceChildren(...nodes);
	fitAllText();
}

export function clear() {
	rendered = null;
	el.overlay.replaceChildren();
	// A peek describes a chip that no longer exists, e.g. after a language change.
	hidePeek();
}

const overflows = (node) =>
	node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1;

/**
 * Font size derives from each block's height in image pixels, scaled to display
 * pixels. A translation longer than its source will overflow, so shrink until
 * it fits. On a narrow phone some boxes cannot fit at any readable size; those
 * are marked `is-clipped` and stay reachable by tapping.
 */
function fitAllText() {
	if (!rendered?.result.regions.length) return;
	const scale = el.frame.clientWidth / rendered.result.width;
	if (!scale || !Number.isFinite(scale)) return;

	const nodes = el.overlay.children;
	for (let i = 0; i < nodes.length; i++) {
		const node = nodes[i];
		let size = Math.max(MIN_FONT_PX, rendered.result.regions[i].box.h * scale * FONT_HEIGHT_RATIO);
		node.style.fontSize = `${size}px`;

		while (overflows(node) && size > MIN_FONT_PX) {
			size = Math.max(MIN_FONT_PX, size * SHRINK_STEP);
			node.style.fontSize = `${size}px`;
		}
		node.classList.toggle("is-clipped", overflows(node));
	}
}

// Font sizes are in px, so they must be recomputed whenever the frame resizes.
new ResizeObserver(fitAllText).observe(el.frame);

/* ------------------------------------------------------------------ export */

/** Flatten photo + overlay into one PNG at full bitmap resolution. */
export function compose(bitmap) {
	const { result, colors } = rendered;
	const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
	const ctx = canvas.getContext("2d");
	ctx.drawImage(bitmap, 0, 0);

	result.regions.forEach((region, index) => {
		const { x, y, w, h } = region.box;
		const color = colors[index] ?? FALLBACK_COLOR;

		ctx.fillStyle = color.bg;
		ctx.fillRect(x, y, w, h);

		ctx.fillStyle = color.fg;
		ctx.textBaseline = "middle";
		const weight = region.type === "title" ? "700" : "400";
		let size = Math.max(MIN_CANVAS_FONT_PX, h * FONT_HEIGHT_RATIO);
		do {
			ctx.font = `${weight} ${size}px system-ui, sans-serif`;
			if (ctx.measureText(region.translated).width <= w - 6) break;
			size *= SHRINK_STEP;
		} while (size > MIN_CANVAS_FONT_PX);

		ctx.save();
		ctx.beginPath();
		ctx.rect(x, y, w, h);
		ctx.clip();
		ctx.fillText(region.translated, x + 3, y + h / 2);
		ctx.restore();
	});

	return canvas.convertToBlob({ type: "image/png" });
}

/* -------------------------------------------------------------------- peek */

const PEEK_TIMEOUT_MS = 6000;
let peekTimer = null;
/** The chip the peek is describing, highlighted so the two read as a pair. */
let peekedNode = null;

/** Full text for a region, so a clipped box is never a dead end. */
export function showPeek(region, node = null) {
	el.peekTranslation.textContent = region.translated;
	el.peekText.textContent = region.source;
	el.peek.hidden = false;
	peekedNode?.classList.remove("is-peeked");
	peekedNode = node;
	peekedNode?.classList.add("is-peeked");
	clearTimeout(peekTimer);
	peekTimer = setTimeout(hidePeek, PEEK_TIMEOUT_MS);
}

export function hidePeek() {
	el.peek.hidden = true;
	peekedNode?.classList.remove("is-peeked");
	peekedNode = null;
}

el.peekClose.addEventListener("click", hidePeek);
