/**
 * Translate - client.
 *
 * Screens are driven by `body[data-state]`, which CSS alone turns into the
 * right layer + dock. States: camera | captured | working | result | upload.
 *
 * The browser owns four jobs the Worker deliberately does not:
 *  1. The live viewfinder and capture.
 *  2. Downscaling and JPEG encoding, so the Worker never burns CPU on pixels.
 *  3. EXIF orientation, so a phone photo is upright before OCR sees it.
 *  4. Overlay rendering and colour sampling, which need no server image stack.
 *
 * Geometry contract: OCR block coordinates are pixels in the space of the
 * image we uploaded. We display that exact bitmap, and the frame is locked to
 * its aspect ratio, so positioning is a pure percentage mapping.
 */

const MAX_EDGE = 1600; // longest edge we upload; larger costs latency, not accuracy
const JPEG_QUALITY = 0.85;
const STORAGE_KEY = "translate.target";

const el = {};
for (const id of [
	"video", "viewer", "frame", "photo", "overlay", "scanner", "dropzone",
	"ambient", "primer", "allow-camera", "primer-pick",
	"dropnote", "choose", "enable-camera", "target", "toast", "camerabar",
	"pick", "shutter", "flip", "sheet", "sheet-title", "sheet-sub", "retake",
	"toggle", "toggle-label", "download", "peek", "peek-text", "peek-close",
	"peek-translation", "camera-input", "file",
	"install", "install-go", "install-no", "install-sub",
]) {
	el[id] = document.getElementById(id);
}

/** Current photo + result. */
let current = { bitmap: null, dataUrl: null, result: null, colors: [] };
let stream = null;
let facing = "environment";
let inFlight = 0; // ignore responses from superseded requests

const setState = (state) => (document.body.dataset.state = state);
const stateIs = (state) => document.body.dataset.state === state;

/* --------------------------------------------------------------- languages */

async function loadLanguages() {
	let languages = { en: "English", es: "Spanish", fr: "French", de: "German" };
	try {
		const response = await fetch("/api/languages");
		if (response.ok) languages = (await response.json()).languages ?? languages;
	} catch {
		/* offline: fallback list still lets the UI work */
	}
	const saved = localStorage.getItem(STORAGE_KEY) ?? "en";
	el.target.replaceChildren(
		...Object.entries(languages).map(([code, name]) => {
			const option = document.createElement("option");
			option.value = code;
			option.textContent = name;
			option.selected = code === saved;
			return option;
		}),
	);
}

el.target.addEventListener("change", () => {
	localStorage.setItem(STORAGE_KEY, el.target.value);
	// Re-translate the photo already on screen rather than making the user retake it.
	if (current.dataUrl) translate(current.dataUrl);
});

/* ------------------------------------------------------------------ camera */

/** Phones and tablets get the viewfinder first; desktops get the upload card. */
const prefersCamera = matchMedia("(pointer: coarse)").matches;

/**
 * Show our own explanation before the browser's permission dialog, so the user
 * knows why the camera is being requested. Skipped once permission is already
 * granted, so returning users land straight on the viewfinder.
 */
async function bootCamera() {
	let permission = "prompt";
	try {
		const status = await navigator.permissions?.query({ name: "camera" });
		if (status?.state) permission = status.state;
	} catch {
		// Safari has no 'camera' permission descriptor; fall through to the primer.
	}
	if (permission === "granted") await startCamera();
	else setState("primer");
}

el["allow-camera"].addEventListener("click", () => startCamera({ userInitiated: true }));
el["primer-pick"].addEventListener("click", () => el.file.click());

async function startCamera({ userInitiated = false } = {}) {
	if (!navigator.mediaDevices?.getUserMedia) {
		return fallbackToUpload("This browser has no camera access.");
	}
	// getUserMedia needs a secure context. file:// or plain http on a LAN IP
	// will fail here, which is confusing unless we say so.
	if (!window.isSecureContext) {
		return fallbackToUpload("Camera needs HTTPS. Use localhost or a secure URL.");
	}

	stopCamera();
	try {
		stream = await navigator.mediaDevices.getUserMedia({
			video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 } },
			audio: false,
		});
	} catch (error) {
		const denied = error.name === "NotAllowedError";
		return fallbackToUpload(
			denied ? "Camera permission denied." : "No camera available.",
			userInitiated && denied,
		);
	}

	el.video.srcObject = stream;
	await el.video.play().catch(() => {});
	// Only offer the flip control when there is more than one camera.
	const cameras = await navigator.mediaDevices
		.enumerateDevices()
		.then((d) => d.filter((x) => x.kind === "videoinput").length)
		.catch(() => 1);
	el.flip.hidden = cameras < 2;
	setState("camera");
}

function stopCamera() {
	stream?.getTracks().forEach((track) => track.stop());
	stream = null;
	el.video.srcObject = null;
}

function fallbackToUpload(reason, loud = false) {
	stopCamera();
	el.dropnote.textContent = `${reason} Drop an image here, or choose one instead.`;
	setState("upload");
	if (loud) showToast(reason, true);
}

el["enable-camera"].addEventListener("click", () => startCamera({ userInitiated: true }));
el.flip.addEventListener("click", () => {
	facing = facing === "environment" ? "user" : "environment";
	startCamera();
});

/**
 * The viewfinder is `object-fit: cover`, so the element shows a centred crop of
 * the camera frame — a 16:9 stream on a tall phone hides most of its width.
 * Capturing the raw frame would therefore translate text the user never saw.
 * This reproduces the same crop so the photo matches the preview exactly, on
 * every screen shape.
 */
async function captureVisibleFrame(video) {
	const frameW = video.videoWidth;
	const frameH = video.videoHeight;
	const viewW = video.clientWidth;
	const viewH = video.clientHeight;

	// `cover` scales by whichever axis needs the most magnification.
	const scale = Math.max(viewW / frameW, viewH / frameH);
	const cropW = Math.min(frameW, Math.round(viewW / scale));
	const cropH = Math.min(frameH, Math.round(viewH / scale));
	const cropX = Math.round((frameW - cropW) / 2);
	const cropY = Math.round((frameH - cropH) / 2);

	const canvas = new OffscreenCanvas(cropW, cropH);
	canvas.getContext("2d").drawImage(video, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
	return createImageBitmap(canvas);
}

el.shutter.addEventListener("click", async () => {
	if (!stream || !el.video.videoWidth) return;
	el.shutter.disabled = true;
	try {
		await accept(await captureVisibleFrame(el.video));
	} catch (error) {
		showToast(`Capture failed: ${error.message}`, true);
	} finally {
		el.shutter.disabled = false;
	}
});

// Pause the camera while backgrounded; resume when the user returns.
document.addEventListener("visibilitychange", () => {
	if (document.hidden) stopCamera();
	else if (stateIs("camera")) startCamera();
});

/* ------------------------------------------------------------- file inputs */

el.pick.addEventListener("click", () => el.file.click());
el.choose.addEventListener("click", () => el.file.click());
el.file.addEventListener("change", onFileInput);
el["camera-input"].addEventListener("change", onFileInput);

async function onFileInput(event) {
	const file = event.target.files?.[0];
	event.target.value = "";
	if (file) await acceptFile(file);
}

// Drag and drop onto the upload card.
for (const type of ["dragenter", "dragover"]) {
	el.dropzone.addEventListener(type, (e) => {
		e.preventDefault();
		el.dropzone.classList.add("dragging");
	});
}
for (const type of ["dragleave", "drop"]) {
	el.dropzone.addEventListener(type, (e) => {
		e.preventDefault();
		el.dropzone.classList.remove("dragging");
	});
}
el.dropzone.addEventListener("drop", (e) => {
	const file = e.dataTransfer?.files?.[0];
	if (file?.type.startsWith("image/")) acceptFile(file);
});

async function acceptFile(file) {
	try {
		// `from-image` applies EXIF rotation, so a sideways phone photo is
		// upright before OCR sees it. Without it every box would be rotated.
		const source = await createImageBitmap(file, { imageOrientation: "from-image" });
		await accept(source);
	} catch (error) {
		showToast(`Could not read that image: ${error.message}`, true);
	}
}

/** Shared entry point for camera frames and picked files. */
async function accept(sourceBitmap) {
	const bitmap = await downscale(sourceBitmap);
	const dataUrl = await toJpegDataUrl(bitmap);
	stopCamera();

	current = { bitmap, dataUrl, result: null, colors: [] };
	el.photo.src = dataUrl;
	// Same photo, blurred behind the frame, so letterboxing picks up its colour.
	el.ambient.style.backgroundImage = `url("${dataUrl}")`;
	el.frame.style.aspectRatio = `${bitmap.width} / ${bitmap.height}`;
	el.overlay.replaceChildren();
	setState("captured");
	await translate(dataUrl);
}

async function downscale(bitmap) {
	const longest = Math.max(bitmap.width, bitmap.height);
	if (longest <= MAX_EDGE) return bitmap;
	const scale = MAX_EDGE / longest;
	const width = Math.round(bitmap.width * scale);
	const height = Math.round(bitmap.height * scale);
	const canvas = new OffscreenCanvas(width, height);
	canvas.getContext("2d").drawImage(bitmap, 0, 0, width, height);
	return createImageBitmap(canvas);
}

async function toJpegDataUrl(bitmap) {
	const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
	canvas.getContext("2d").drawImage(bitmap, 0, 0);
	const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: JPEG_QUALITY });
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result);
		reader.onerror = () => reject(new Error("could not encode image"));
		reader.readAsDataURL(blob);
	});
}

/* ----------------------------------------------------------------- request */

async function translate(dataUrl) {
	const ticket = ++inFlight;
	setState("working");
	el.scanner.hidden = false;
	el.overlay.replaceChildren();
	el.install.hidden = true;
	showToast("Reading the image…", false, true);

	// Fail fast and honestly rather than waiting out a fetch that cannot work.
	if (navigator.onLine === false) {
		el.scanner.hidden = true;
		setState("result");
		el["sheet-title"].textContent = "You're offline";
		el["sheet-sub"].textContent = "Translating needs a connection. The app still opens offline.";
		showToast("No connection", true);
		return;
	}

	try {
		const response = await fetch("/api/translate", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ image: dataUrl, target: el.target.value }),
		});
		const payload = await response.json();
		if (ticket !== inFlight) return; // a newer request already won
		if (!response.ok) throw new Error(payload.error ?? `request failed (${response.status})`);

		el.scanner.hidden = true;
		current.result = payload;

		if (payload.regions.length === 0) {
			setState("result");
			hideToast();
			el["sheet-title"].textContent = "No text found";
			el["sheet-sub"].textContent = "Try getting closer, or steadier.";
			return;
		}

		current.colors = sampleColors(current.bitmap, payload.regions);
		render(payload);
		setState("result");
		hideToast();
		// Value delivered: the install offer is now earned, but not yet shown.
		earnedInstall = true;

		const missing = payload.regions.filter((r) => !r.translatedOk).length;
		el["sheet-title"].textContent = `${payload.detectedLanguage.toUpperCase()} → ${el.target.value.toUpperCase()}`;
		el["sheet-sub"].textContent =
			`${payload.regions.length} regions · ${payload.timings.totalMs} ms` +
			(missing ? ` · ${missing} untranslated` : "");
	} catch (error) {
		if (ticket !== inFlight) return;
		el.scanner.hidden = true;
		setState("result");
		el["sheet-title"].textContent = "Could not translate";
		el["sheet-sub"].textContent = error.message;
		showToast(error.message, true);
	}
}

/* ------------------------------------------------------------ colour match */

/**
 * Sample each box's background straight from the photo so the chip sits in the
 * image instead of on top of it. Only the box's outer edge is read: the middle
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

		let data;
		try {
			data = ctx.getImageData(x, y, w, h).data;
		} catch {
			return { bg: "#ffffff", fg: "#10151c" };
		}

		let r = 0, g = 0, b = 0, n = 0;
		const edge = Math.max(1, Math.round(Math.min(w, h) * 0.18));
		for (let row = 0; row < h; row++) {
			const vertical = row < edge || row >= h - edge;
			for (let col = 0; col < w; col++) {
				if (!vertical && col >= edge && col < w - edge) continue;
				const i = (row * w + col) * 4;
				r += data[i];
				g += data[i + 1];
				b += data[i + 2];
				n++;
			}
		}
		if (!n) return { bg: "#ffffff", fg: "#10151c" };
		r = Math.round(r / n);
		g = Math.round(g / n);
		b = Math.round(b / n);

		// Perceptual luminance decides whether text should be dark or light.
		const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
		return {
			bg: `rgb(${r} ${g} ${b})`,
			fg: luminance > 0.55 ? "#10151c" : "#ffffff",
		};
	});
}

/* ----------------------------------------------------------------- overlay */

function render(result) {
	const nodes = result.regions.map((region, index) => {
		const color = current.colors[index] ?? { bg: "#fff", fg: "#10151c" };
		const node = document.createElement("div");
		node.className = "region";
		if (region.type === "title") node.classList.add("is-title");
		if (region.confidence !== null && region.confidence < 0.7) node.classList.add("is-low");

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
		node.addEventListener("click", () => showPeek(region));
		return node;
	});

	el.overlay.replaceChildren(...nodes);
	fitAllText();
}

/** Below this the text stops being readable, so we clip instead of shrinking. */
const MIN_FONT_PX = 5;

/**
 * Font size derives from each block's height in image pixels, scaled to display
 * pixels. A translation longer than its source will overflow, so shrink until
 * it fits. On a narrow phone some boxes cannot fit at any readable size; those
 * get marked `is-clipped` and stay reachable by tapping.
 */
function fitAllText() {
	const result = current.result;
	if (!result?.regions?.length) return;
	const scale = el.frame.clientWidth / result.width;
	if (!scale || !Number.isFinite(scale)) return;

	const overflows = (node) =>
		node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1;

	const nodes = el.overlay.children;
	for (let i = 0; i < nodes.length; i++) {
		const node = nodes[i];
		let size = Math.max(MIN_FONT_PX, result.regions[i].box.h * scale * 0.74);
		node.style.fontSize = `${size}px`;

		while (overflows(node) && size > MIN_FONT_PX) {
			size = Math.max(MIN_FONT_PX, size * 0.9);
			node.style.fontSize = `${size}px`;
		}
		node.classList.toggle("is-clipped", overflows(node));
	}
}

new ResizeObserver(() => fitAllText()).observe(el.frame);

/* ---------------------------------------------------------------- controls */

// Press and hold to compare against the original.
const showOriginal = (on) => {
	el.overlay.classList.toggle("muted", on);
	el.toggle.setAttribute("aria-pressed", String(!on));
	el["toggle-label"].textContent = on ? "Showing original" : "Hold to compare";
};
for (const type of ["pointerdown"]) el.toggle.addEventListener(type, () => showOriginal(true));
for (const type of ["pointerup", "pointerleave", "pointercancel"]) {
	el.toggle.addEventListener(type, () => showOriginal(false));
}

el.retake.addEventListener("click", reset);
el["peek-close"].addEventListener("click", () => (el.peek.hidden = true));

el.download.addEventListener("click", async () => {
	if (!current.result?.regions?.length || !current.bitmap) return;
	const blob = await compose();
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = `translate-${current.result.targetLanguage}.png`;
	link.click();
	URL.revokeObjectURL(url);
	showToast("Saved");
	setTimeout(hideToast, 1600);
});

/** Flatten photo + overlay into one PNG at full bitmap resolution. */
async function compose() {
	const { bitmap, result, colors } = current;
	const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
	const ctx = canvas.getContext("2d");
	ctx.drawImage(bitmap, 0, 0);

	result.regions.forEach((region, index) => {
		const { x, y, w, h } = region.box;
		const color = colors[index] ?? { bg: "#ffffff", fg: "#10151c" };
		ctx.fillStyle = color.bg;
		ctx.fillRect(x, y, w, h);

		ctx.fillStyle = color.fg;
		ctx.textBaseline = "middle";
		const weight = region.type === "title" ? "700" : "400";
		let size = Math.max(7, h * 0.74);
		do {
			ctx.font = `${weight} ${size}px system-ui, sans-serif`;
			if (ctx.measureText(region.translated).width <= w - 6) break;
			size *= 0.9;
		} while (size > 7);

		ctx.save();
		ctx.beginPath();
		ctx.rect(x, y, w, h);
		ctx.clip();
		ctx.fillText(region.translated, x + 3, y + h / 2);
		ctx.restore();
	});
	return canvas.convertToBlob({ type: "image/png" });
}

/** Full text for a region, so a clipped box is never a dead end. */
function showPeek(region) {
	el["peek-translation"].textContent = region.translated;
	el["peek-text"].textContent = region.source;
	el.peek.hidden = false;
	clearTimeout(showPeek.timer);
	showPeek.timer = setTimeout(() => (el.peek.hidden = true), 6000);
}

function reset() {
	inFlight++;
	// Going back for a second photo is the seam: the user is done reading and
	// has just demonstrated repeat intent, which is a far better install signal
	// than elapsed time — and by now Chrome's engagement heuristic has passed.
	maybeOfferInstall();
	current = { bitmap: null, dataUrl: null, result: null, colors: [] };
	el.overlay.replaceChildren();
	el.photo.removeAttribute("src");
	el.ambient.style.backgroundImage = "";
	el.peek.hidden = true;
	el.scanner.hidden = true;
	hideToast();
	if (stream) startCamera();
	else if (prefersCamera) bootCamera();
	else setState("upload");
}

/* ----------------------------------------------------------------- install */

/*
 * Timing, and why it is not a timer.
 *
 * Chrome only fires `beforeinstallprompt` once its own engagement heuristics
 * pass, which include ~30s on the page. A camera -> shutter -> result run can
 * finish well inside that, so prompting on a fixed delay after the first
 * translation would often find no prompt to show.
 *
 * Instead the banner needs two things, and appears when the later one lands:
 *   1. a translation has succeeded (the user has seen the value), and
 *   2. the browser has actually handed us a prompt (Chromium) or we know the
 *      manual route (iOS).
 * It is then surfaced at a seam — tapping "New photo" — rather than over the
 * translation the user is still reading.
 */
const INSTALL_KEY = "translate.install.dismissed";
const INSTALL_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

let deferredPrompt = null;
let earnedInstall = false; // at least one successful translation this session

const isStandalone = () =>
	matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

/*
 * Only Chromium implements beforeinstallprompt, so its absence is what actually
 * defines "must install by hand". Testing the capability rather than the user
 * agent also avoids a false positive on desktop Chrome, where `MacIntel` plus
 * emulated touch points otherwise looks exactly like an iPad.
 */
const canPromptToInstall = "onbeforeinstallprompt" in window;

const isIos = () =>
	!canPromptToInstall &&
	(/iphone|ipad|ipod/i.test(navigator.userAgent) ||
		// iPadOS 13+ reports as a Mac; touch points disambiguate it.
		(navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

function installDismissedRecently() {
	const at = Number(localStorage.getItem(INSTALL_KEY) || 0);
	return at > 0 && Date.now() - at < INSTALL_COOLDOWN_MS;
}

window.addEventListener("beforeinstallprompt", (event) => {
	// Suppress the browser's own bar; we choose the moment.
	event.preventDefault();
	deferredPrompt = event;
});

window.addEventListener("appinstalled", () => {
	deferredPrompt = null;
	el.install.hidden = true;
	localStorage.setItem(INSTALL_KEY, String(Date.now()));
});

/** Called at natural seams. Shows nothing unless every gate passes. */
function maybeOfferInstall() {
	if (el.install.hidden === false) return;
	if (!earnedInstall || isStandalone() || installDismissedRecently()) return;

	const ios = isIos();
	if (!deferredPrompt && !ios) return; // nothing we could actually do

	if (ios) {
		el.install.classList.add("is-ios");
		el["install-sub"].innerHTML =
			'Tap <span class="install-share" aria-hidden="true">' +
			'<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
			'<path d="M12 15V3" /><path d="m8 7 4-4 4 4" />' +
			'<path d="M4 13v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6" /></svg></span>' +
			" Share, then <strong>Add to Home Screen</strong>.";
	}
	el.install.hidden = false;
}

el["install-go"].addEventListener("click", async () => {
	el.install.hidden = true;
	if (!deferredPrompt) return;
	const prompt = deferredPrompt;
	deferredPrompt = null; // a prompt can only be used once
	prompt.prompt();
	const choice = await prompt.userChoice.catch(() => null);
	if (choice?.outcome !== "accepted") localStorage.setItem(INSTALL_KEY, String(Date.now()));
});

el["install-no"].addEventListener("click", () => {
	el.install.hidden = true;
	localStorage.setItem(INSTALL_KEY, String(Date.now()));
});

/* ------------------------------------------------------------------- toast */

function showToast(message, isError = false, busy = false) {
	el.toast.className = `toast${isError ? " is-error" : ""}`;
	el.toast.hidden = false;
	el.toast.replaceChildren();
	if (busy) {
		const spinner = document.createElement("div");
		spinner.className = "spinner";
		el.toast.append(spinner);
	}
	el.toast.append(document.createTextNode(message));
}

function hideToast() {
	el.toast.hidden = true;
	el.toast.replaceChildren();
}

/* -------------------------------------------------------------------- boot */

/* -------------------------------------------------------------------- boot */

// Shell caching only; the worker explicitly never caches /api/*.
if ("serviceWorker" in navigator) {
	window.addEventListener("load", () => {
		navigator.serviceWorker.register("/sw.js").catch((error) => {
			console.warn("service worker registration failed", error);
		});
	});
}

await loadLanguages();
if (prefersCamera) await bootCamera();
else setState("upload");
