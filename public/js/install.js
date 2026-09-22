/**
 * PWA install offer.
 *
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

import { el } from "./ui.js";

const DISMISSED_KEY = "translate.install.dismissed";
const COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

let deferredPrompt = null;
let earned = false;

/**
 * Only Chromium implements beforeinstallprompt, so its absence is what actually
 * defines "must install by hand". Testing the capability rather than the user
 * agent also avoids a false positive on desktop Chrome, where `MacIntel` plus
 * emulated touch points otherwise looks exactly like an iPad.
 */
const canPromptToInstall = "onbeforeinstallprompt" in window;

const isStandalone = () =>
	matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

const isIos = () =>
	!canPromptToInstall &&
	(/iphone|ipad|ipod/i.test(navigator.userAgent) ||
		// iPadOS 13+ reports as a Mac; touch points disambiguate it.
		(navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

const dismissedRecently = () => {
	const at = Number(localStorage.getItem(DISMISSED_KEY) || 0);
	return at > 0 && Date.now() - at < COOLDOWN_MS;
};

const remember = () => localStorage.setItem(DISMISSED_KEY, String(Date.now()));

const IOS_INSTRUCTIONS =
	'Tap <span class="install-share" aria-hidden="true">' +
	'<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
	'<path d="M12 15V3" /><path d="m8 7 4-4 4 4" />' +
	'<path d="M4 13v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6" /></svg></span>' +
	" Share, then <strong>Add to Home Screen</strong>.";

/** Called once a translation has succeeded. Does not show anything yet. */
export function markEarned() {
	earned = true;
}

export function hide() {
	el.install.hidden = true;
}

/** Called at natural seams. Shows nothing unless every gate passes. */
export function maybeOffer() {
	if (!el.install.hidden) return;
	if (!earned || isStandalone() || dismissedRecently()) return;

	const ios = isIos();
	if (!deferredPrompt && !ios) return; // nothing we could actually do

	if (ios) {
		el.install.classList.add("is-ios");
		el.installSub.innerHTML = IOS_INSTRUCTIONS;
	}
	el.install.hidden = false;
}

/* ------------------------------------------------------------------ wiring */

window.addEventListener("beforeinstallprompt", (event) => {
	// Suppress the browser's own bar; we choose the moment.
	event.preventDefault();
	deferredPrompt = event;
});

window.addEventListener("appinstalled", () => {
	deferredPrompt = null;
	hide();
	remember();
});

el.installGo.addEventListener("click", async () => {
	hide();
	if (!deferredPrompt) return;
	const prompt = deferredPrompt;
	deferredPrompt = null; // a prompt can only be used once
	prompt.prompt();
	const choice = await prompt.userChoice.catch(() => null);
	if (choice?.outcome !== "accepted") remember();
});

el.installNo.addEventListener("click", () => {
	hide();
	remember();
});
