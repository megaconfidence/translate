/**
 * Translate - client.
 *
 * The browser owns three jobs the Worker deliberately does not:
 *  1. Downscaling and JPEG encoding, so the Worker never burns CPU on pixels.
 *  2. EXIF orientation, so a phone photo is upright before OCR sees it.
 *  3. Overlay rendering, which needs no server-side image toolchain.
 *
 * OCR block coordinates come back as pixels in the space of the image we
 * uploaded. Because we uploaded the downscaled bitmap, that space is exactly
 * the bitmap we are displaying, so positioning is a pure percentage mapping.
 */

/** Longest edge we upload. Bigger costs bytes and latency without helping OCR. */
const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.85;

const el = {
	target: document.getElementById("target"),
	start: document.getElementById("start"),
	stage: document.getElementById("stage"),
	take: document.getElementById("take"),
	pick: document.getElementById("pick"),
	camera: document.getElementById("camera"),
	file: document.getElementById("file"),
	frame: document.getElementById("frame"),
	photo: document.getElementById("photo"),
	overlay: document.getElementById("overlay"),
	status: document.getElementById("status"),
	controls: document.getElementById("controls"),
	toggle: document.getElementById("toggle"),
	download: document.getElementById("download"),
	again: document.getElementById("again"),
	meta: document.getElementById("meta"),
	peek: document.getElementById("peek"),
	peekText: document.getElementById("peek-text"),
};

/** Current render state. */
let current = { bitmap: null, dataUrl: null, result: null };

/* ---------------------------------------------------------------- languages */

const STORAGE_KEY = "translate.target";

async function loadLanguages() {
	const fallback = { en: "English", es: "Spanish", fr: "French", de: "German" };
	let languages = fallback;
	try {
		const response = await fetch("/api/languages");
		if (response.ok) languages = (await response.json()).languages ?? fallback;
	} catch {
		/* offline: the fallback list still lets the UI render */
	}
	const saved = localStorage.getItem(STORAGE_KEY) ?? "en";
	el.target.innerHTML = "";
	for (const [code, name] of Object.entries(languages)) {
		const option = document.createElement("option");
		option.value = code;
		option.textContent = name;
		if (code === saved) option.selected = true;
		el.target.append(option);
	}
}

el.target.addEventListener("change", () => {
	localStorage.setItem(STORAGE_KEY, el.target.value);
	// Re-run against the image already on screen rather than making the user
	// take the photo again.
	if (current.dataUrl) translate(current.dataUrl);
});

/* -------------------------------------------------------------- image input */

el.take.addEventListener("click", () => el.camera.click());
el.pick.addEventListener("click", () => el.file.click());
el.camera.addEventListener("change", onFile);
el.file.addEventListener("change", onFile);
el.again.addEventListener("click", reset);

async function onFile(event) {
	const file = event.target.files?.[0];
	event.target.value = "";
	if (!file) return;

	try {
		// `from-image` applies the EXIF rotation, so a sideways phone photo is
		// upright before OCR sees it. Without this, every box would be rotated.
		const source = await createImageBitmap(file, { imageOrientation: "from-image" });
		const bitmap = await downscale(source);
		const dataUrl = await toJpegDataUrl(bitmap);

		current = { bitmap, dataUrl, result: null };
		el.photo.src = dataUrl;
		el.start.hidden = true;
		el.stage.hidden = false;
		await translate(dataUrl);
	} catch (error) {
		showError(`Could not read that image: ${error.message}`);
	}
}

/** Fit inside MAX_EDGE, preserving aspect. Returns the original if small enough. */
async function downscale(bitmap) {
	const longest = Math.max(bitmap.width, bitmap.height);
	if (longest <= MAX_EDGE) return bitmap;
	const scale = MAX_EDGE / longest;
	const width = Math.round(bitmap.width * scale);
	const height = Math.round(bitmap.height * scale);
	const canvas = new OffscreenCanvas(width, height);
	const context = canvas.getContext("2d");
	context.drawImage(bitmap, 0, 0, width, height);
	return createImageBitmap(canvas);
}

async function toJpegDataUrl(bitmap) {
	const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
	canvas.getContext("2d").drawImage(bitmap, 0, 0);
	const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: JPEG_QUALITY });
	return await new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result);
		reader.onerror = () => reject(new Error("could not encode image"));
		reader.readAsDataURL(blob);
	});
}

/* ------------------------------------------------------------------ request */

async function translate(dataUrl) {
	setBusy("Reading the image…");
	el.controls.hidden = true;
	el.overlay.innerHTML = "";
	el.meta.textContent = "";

	try {
		const response = await fetch("/api/translate", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ image: dataUrl, target: el.target.value }),
		});
		const payload = await response.json();
		if (!response.ok) throw new Error(payload.error ?? `request failed (${response.status})`);

		current.result = payload;
		if (payload.regions.length === 0) {
			showError("No text found in that image.");
			el.controls.hidden = false;
			return;
		}

		render(payload);
		clearStatus();
		el.controls.hidden = false;

		const missing = payload.regions.filter((r) => !r.translatedOk).length;
		el.meta.textContent =
			`${payload.regions.length} regions · detected ${payload.detectedLanguage} · ` +
			`OCR ${payload.timings.ocrMs} ms · translate ${payload.timings.translateMs} ms` +
			(missing ? ` · ${missing} untranslated` : "");
	} catch (error) {
		showError(error.message);
		el.controls.hidden = false;
	}
}

/* ----------------------------------------------------------------- overlay */

function render(result) {
	el.overlay.innerHTML = "";

	for (const region of result.regions) {
		const node = document.createElement("div");
		node.className = "region";
		if (region.type === "title") node.classList.add("title");
		if (region.confidence !== null && region.confidence < 0.7) node.classList.add("low");

		// Percentages keep the box glued to the artwork at any rendered size.
		node.style.left = `${(region.box.x / result.width) * 100}%`;
		node.style.top = `${(region.box.y / result.height) * 100}%`;
		node.style.width = `${(region.box.w / result.width) * 100}%`;
		node.style.height = `${(region.box.h / result.height) * 100}%`;

		const span = document.createElement("span");
		span.textContent = region.translated;
		node.append(span);

		node.addEventListener("click", () => showPeek(region.source));
		el.overlay.append(node);
	}

	fitAllText();
}

/**
 * Font size is derived from each block's height in image pixels, converted to
 * displayed pixels. If the translation is longer than the source it will
 * overflow the box, so shrink until it fits or we hit a readability floor.
 */
function fitAllText() {
	const result = current.result;
	if (!result) return;
	const scale = el.frame.clientWidth / result.width;
	if (!scale || !Number.isFinite(scale)) return;

	const nodes = el.overlay.children;
	for (let i = 0; i < nodes.length; i++) {
		const node = nodes[i];
		const region = result.regions[i];
		const boxHeight = region.box.h * scale;

		let size = Math.max(6, boxHeight * 0.74);
		node.style.fontSize = `${size}px`;

		// Shrink to fit. Bounded loop: never more than 12 reflows per region.
		for (let step = 0; step < 12; step++) {
			const overflows =
				node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1;
			if (!overflows || size <= 6) break;
			size *= 0.88;
			node.style.fontSize = `${size}px`;
		}
	}
}

// The frame resizes with the viewport; font sizes are in px so they must follow.
new ResizeObserver(() => fitAllText()).observe(el.frame);

/* ----------------------------------------------------------------- controls */

el.toggle.addEventListener("click", () => {
	const hidden = el.overlay.classList.toggle("hidden");
	el.toggle.textContent = hidden ? "Show translation" : "Show original";
	el.toggle.setAttribute("aria-pressed", String(!hidden));
});

el.download.addEventListener("click", async () => {
	if (!current.result || !current.bitmap) return;
	const blob = await compose();
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = `translate-${current.result.targetLanguage}.png`;
	link.click();
	URL.revokeObjectURL(url);
});

/** Flatten photo + overlay into a single PNG at full bitmap resolution. */
async function compose() {
	const { bitmap, result } = current;
	const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
	const ctx = canvas.getContext("2d");
	ctx.drawImage(bitmap, 0, 0);

	for (const region of result.regions) {
		const { x, y, w, h } = region.box;
		ctx.fillStyle = "#fffdf7";
		ctx.fillRect(x, y, w, h);

		ctx.fillStyle = "#14181e";
		ctx.textBaseline = "middle";
		const weight = region.type === "title" ? "700" : "400";
		let size = Math.max(7, h * 0.74);
		do {
			ctx.font = `${weight} ${size}px system-ui, sans-serif`;
			if (ctx.measureText(region.translated).width <= w - 4) break;
			size *= 0.9;
		} while (size > 7);
		ctx.save();
		ctx.beginPath();
		ctx.rect(x, y, w, h);
		ctx.clip();
		ctx.fillText(region.translated, x + 2, y + h / 2);
		ctx.restore();
	}
	return canvas.convertToBlob({ type: "image/png" });
}

function showPeek(text) {
	el.peekText.textContent = text;
	el.peek.hidden = false;
	clearTimeout(showPeek.timer);
	showPeek.timer = setTimeout(() => (el.peek.hidden = true), 4000);
}

function reset() {
	current = { bitmap: null, dataUrl: null, result: null };
	el.overlay.innerHTML = "";
	el.photo.removeAttribute("src");
	el.stage.hidden = true;
	el.start.hidden = false;
	el.controls.hidden = true;
	el.peek.hidden = true;
	clearStatus();
	el.meta.textContent = "";
}

/* ------------------------------------------------------------------- status */

function setBusy(message) {
	el.status.className = "status";
	el.status.hidden = false;
	el.status.innerHTML = "";
	const spinner = document.createElement("div");
	spinner.className = "spinner";
	el.status.append(spinner, document.createTextNode(message));
}

function showError(message) {
	el.status.className = "status error";
	el.status.hidden = false;
	el.status.textContent = message;
}

function clearStatus() {
	el.status.hidden = true;
	el.status.textContent = "";
}

loadLanguages();
