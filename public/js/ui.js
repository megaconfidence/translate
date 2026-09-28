/**
 * Shared DOM handles and the three primitives every other module needs:
 * which screen is showing, what the result sheet says, and the toast.
 */

/**
 * Ids are listed in markup form and exposed as camelCase, so call sites read
 * `el.sheetTitle` rather than `el["sheet-title"]`.
 */
const IDS = [
	"video", "frame", "photo", "overlay", "scanner", "ambient",
	"dropzone", "dropnote", "choose", "enable-camera",
	"allow-camera", "primer-pick", "sample", "primer-sample",
	"target", "toast",
	"pick", "shutter", "flip",
	"sheet-title", "sheet-sub", "retake",
	"toggle", "toggle-label", "download",
	"peek", "peek-translation", "peek-text", "peek-close",
	"file",
	"install", "install-go", "install-no", "install-sub",
];

const camel = (id) => id.replace(/-([a-z])/g, (_, char) => char.toUpperCase());

export const el = Object.fromEntries(IDS.map((id) => [camel(id), document.getElementById(id)]));

/* ------------------------------------------------------------------ state */

/** CSS turns `body[data-state]` into the visible layer and dock. */
export const setState = (state) => (document.body.dataset.state = state);
export const stateIs = (state) => document.body.dataset.state === state;

/** The two lines of the result sheet always change together. */
export function setSheet(title, sub) {
	el.sheetTitle.textContent = title;
	el.sheetSub.textContent = sub;
}

/* ------------------------------------------------------------------ toast */

function showToast(message, { error = false, busy = false } = {}) {
	el.toast.className = `toast${error ? " is-error" : ""}`;
	el.toast.hidden = false;
	el.toast.replaceChildren();
	if (busy) {
		const spinner = document.createElement("div");
		spinner.className = "spinner";
		el.toast.append(spinner);
	}
	el.toast.append(document.createTextNode(message));
}

export const toastBusy = (message) => showToast(message, { busy: true });
export const toastError = (message) => showToast(message, { error: true });
export const toastInfo = (message) => showToast(message);

export function hideToast() {
	el.toast.hidden = true;
	el.toast.replaceChildren();
}
