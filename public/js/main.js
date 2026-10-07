/**
 * Translate - entry point.
 *
 * Owns the session (the current photo and its result) and wires the modules
 * together. Everything else lives in:
 *   ui.js       DOM handles, screen state, sheet, toast
 *   camera.js   permission priming, live stream, capture
 *   image.js    downscale, EXIF, JPEG encode
 *   api.js      the two Worker calls
 *   overlay.js  colour sampling, chip layout, PNG export
 *   install.js  PWA install gating
 *
 * The browser owns the pixel work on purpose: the Worker never decodes, scales
 * or encodes an image, which keeps it far away from its CPU limit.
 */

import { el, setState, setSheet, hideToast, toastBusy, toastError, toastInfo } from "./ui.js";
import {
	bootCamera,
	captureVisibleFrame,
	hasStream,
	prefersCamera,
	startCamera,
	stopCamera,
} from "./camera.js";
import { bitmapFromFile, prepareForUpload } from "./image.js";
import { fetchLanguages, requestTranslation } from "./api.js";
import * as overlay from "./overlay.js";
import * as install from "./install.js";

const TARGET_KEY = "translate.target";
const SAVED_TOAST_MS = 1600;
/** Rendered left to right; the middle one sits on top of the deck. */
const SAMPLES = [
	{ label: "Sign", src: "/samples/sign.jpg" },
	{ label: "Menu", src: "/samples/menu.jpg" },
	{ label: "Map", src: "/samples/map.jpg" },
];

/** The photo on screen and what came back for it. */
let current = { bitmap: null, dataUrl: null, result: null };

/** Increments per request so a superseded response can be ignored. */
let requestSeq = 0;

/* --------------------------------------------------------------- languages */

async function loadLanguages() {
	const languages = await fetchLanguages();
	const saved = localStorage.getItem(TARGET_KEY) ?? "en";
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
	localStorage.setItem(TARGET_KEY, el.target.value);
	// Re-translate the photo already on screen rather than making the user retake it.
	if (current.dataUrl) translate(current.dataUrl);
});

/* ------------------------------------------------------------ image intake */

/** Shared entry point for camera frames and picked files. */
async function accept(sourceBitmap) {
	const { bitmap, dataUrl } = await prepareForUpload(sourceBitmap);
	stopCamera();

	current = { bitmap, dataUrl, result: null };
	el.photo.src = dataUrl;
	// Same photo, blurred behind the frame, so letterboxing picks up its colour.
	el.ambient.style.backgroundImage = `url("${dataUrl}")`;
	el.frame.style.aspectRatio = `${bitmap.width} / ${bitmap.height}`;
	overlay.clear();
	setState("captured");

	await translate(dataUrl);
}

async function acceptFile(file) {
	try {
		await accept(await bitmapFromFile(file));
	} catch (error) {
		toastError(`Could not read that image: ${error.message}`);
	}
}

el.shutter.addEventListener("click", async () => {
	if (!hasStream() || !el.video.videoWidth) return;
	el.shutter.disabled = true;
	try {
		await accept(await captureVisibleFrame(el.video));
	} catch (error) {
		toastError(`Capture failed: ${error.message}`);
	} finally {
		el.shutter.disabled = false;
	}
});

for (const button of [el.pick, el.choose, el.primerPick]) {
	button.addEventListener("click", () => el.file.click());
}

/** Runs a bundled photo through the same pipeline as a picked file. */
async function loadSample(src) {
	try {
		const response = await fetch(src);
		if (!response.ok) throw new Error(`request failed (${response.status})`);
		await accept(await bitmapFromFile(await response.blob()));
	} catch (error) {
		toastError(`Could not load the sample: ${error.message}`);
	}
}

/** Fans the samples out as cards; `--i` is each card's offset from the centre. */
function renderDeck(container) {
	const middle = (SAMPLES.length - 1) / 2;
	container.replaceChildren(
		...SAMPLES.map(({ label, src }, index) => {
			const card = document.createElement("button");
			card.className = "deck-card";
			card.style.setProperty("--i", String(index - middle));
			card.setAttribute("aria-label", `Try the ${label.toLowerCase()} sample`);

			const image = document.createElement("img");
			image.src = src;
			image.alt = "";
			image.decoding = "async";
			image.draggable = false;

			const caption = document.createElement("span");
			caption.className = "deck-label";
			caption.textContent = label;

			card.append(image, caption);
			card.addEventListener("click", () => loadSample(src));
			return card;
		}),
	);
}

for (const container of [el.deck, el.primerDeck]) renderDeck(container);

el.file.addEventListener("change", async (event) => {
	const file = event.target.files?.[0];
	event.target.value = "";
	if (file) await acceptFile(file);
});

// Drag and drop onto the upload card.
for (const type of ["dragenter", "dragover"]) {
	el.dropzone.addEventListener(type, (event) => {
		event.preventDefault();
		el.dropzone.classList.add("dragging");
	});
}
for (const type of ["dragleave", "drop"]) {
	el.dropzone.addEventListener(type, (event) => {
		event.preventDefault();
		// dragleave also fires when crossing between the card's own children.
		if (type === "dragleave" && el.dropzone.contains(event.relatedTarget)) return;
		el.dropzone.classList.remove("dragging");
	});
}
el.dropzone.addEventListener("drop", (event) => {
	const file = event.dataTransfer?.files?.[0];
	if (file?.type.startsWith("image/")) acceptFile(file);
});

/* ------------------------------------------------------------------ request */

const displayNames = typeof Intl.DisplayNames === "function" ? new Intl.DisplayNames(["en"], { type: "language" }) : null;

/** "German" for "de": the picker's own label where there is one, else Intl's. */
function languageName(code) {
	const option = [...el.target.options].find((candidate) => candidate.value === code);
	if (option) return option.textContent;
	try {
		return displayNames?.of(code) ?? code.toUpperCase();
	} catch {
		return code.toUpperCase();
	}
}

/** Ends the request in the result state with an explanation. */
function failResult(title, sub, toast = sub) {
	el.scanner.hidden = true;
	setState("result");
	setSheet(title, sub);
	toastError(toast);
}

async function translate(dataUrl) {
	const ticket = ++requestSeq;
	setState("working");
	el.scanner.hidden = false;
	overlay.clear();
	install.hide();
	toastBusy("Reading the image…");

	// Fail fast and honestly rather than waiting out a fetch that cannot work.
	if (navigator.onLine === false) {
		failResult(
			"You're offline",
			"Translating needs a connection.",
			"No connection",
		);
		return;
	}

	try {
		const result = await requestTranslation(dataUrl, el.target.value);
		if (ticket !== requestSeq) return; // a newer request already won

		el.scanner.hidden = true;
		current.result = result;

		if (result.regions.length === 0) {
			setState("result");
			hideToast();
			setSheet("No text found", "Try getting closer, or steadier.");
			return;
		}

		overlay.render(result, current.bitmap, overlay.showPeek);
		setState("result");
		hideToast();
		// Value delivered: the install offer is now earned, but not yet shown.
		install.markEarned();

		const count = result.regions.length;
		const missing = result.regions.filter((region) => !region.translatedOk).length;
		const target = languageName(result.targetLanguage);
		setSheet(
			result.detectedLanguage === "unknown"
				? `Translated to ${target}`
				: `${languageName(result.detectedLanguage)} → ${target}`,
			`${count} ${count === 1 ? "region" : "regions"} · ${(result.timings.totalMs / 1000).toFixed(1)} s` +
				(missing ? ` · ${missing} untranslated` : ""),
		);
	} catch (error) {
		if (ticket !== requestSeq) return;
		failResult("Could not translate", error.message);
	}
}

/* ----------------------------------------------------------------- controls */

// Press and hold to compare against the original.
const showOriginal = (on) => {
	el.overlay.classList.toggle("muted", on);
	el.toggle.setAttribute("aria-pressed", String(!on));
	el.toggleLabel.textContent = on ? "Showing original" : "Hold to compare";
};
el.toggle.addEventListener("pointerdown", () => showOriginal(true));
for (const type of ["pointerup", "pointerleave", "pointercancel"]) {
	el.toggle.addEventListener(type, () => showOriginal(false));
}

el.download.addEventListener("click", async () => {
	if (!current.result?.regions?.length || !current.bitmap) return;
	const blob = await overlay.compose(current.bitmap);
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = `translate-${current.result.targetLanguage}.png`;
	link.click();
	URL.revokeObjectURL(url);
	toastInfo("Saved");
	setTimeout(hideToast, SAVED_TOAST_MS);
});

el.retake.addEventListener("click", () => {
	// Going back for a second photo is the seam: the user is done reading and
	// has just demonstrated repeat intent, which is a far better install signal
	// than elapsed time — and by now Chrome's engagement heuristic has passed.
	install.maybeOffer();

	requestSeq++;
	current = { bitmap: null, dataUrl: null, result: null };
	overlay.clear();
	overlay.hidePeek();
	el.photo.removeAttribute("src");
	el.ambient.style.backgroundImage = "";
	el.scanner.hidden = true;
	hideToast();

	if (hasStream()) startCamera();
	else if (prefersCamera) bootCamera();
	else setState("upload");
});

/* --------------------------------------------------------------------- boot */

/*
 * Earlier versions registered a service worker that cached the app shell.
 * Browsers keep a registered worker until it is explicitly removed, so clear
 * out any left behind, along with its caches. Safe to delete once old installs
 * have cycled through.
 */
navigator.serviceWorker
	?.getRegistrations()
	.then((registrations) => registrations.forEach((registration) => registration.unregister()))
	.catch(() => {});
globalThis.caches
	?.keys()
	.then((keys) => keys.filter((key) => key.startsWith("translate-shell-")).forEach((key) => caches.delete(key)))
	.catch(() => {});

await loadLanguages();
if (prefersCamera) await bootCamera();
else setState("upload");
