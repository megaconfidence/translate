/**
 * Camera lifecycle: permission priming, the live stream, and capture.
 */

import { el, setState, stateIs, toastError } from "./ui.js";

/** Phones and tablets get the viewfinder first; desktops get the upload card. */
export const prefersCamera = matchMedia("(pointer: coarse)").matches;

let stream = null;
let facing = "environment";

export const hasStream = () => stream !== null;

/**
 * Show our own explanation before the browser's permission dialog, so the user
 * knows why the camera is being requested. Skipped once permission is already
 * granted, so returning users land straight on the viewfinder.
 */
export async function bootCamera() {
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

export async function startCamera({ userInitiated = false } = {}) {
	if (!navigator.mediaDevices?.getUserMedia) {
		return fallbackToUpload("This browser has no camera access.");
	}
	// getUserMedia needs a secure context. A LAN IP over plain http fails here,
	// which is baffling unless we say so.
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
		.then((devices) => devices.filter((device) => device.kind === "videoinput").length)
		.catch(() => 1);
	el.flip.hidden = cameras < 2;

	setState("camera");
}

export function stopCamera() {
	stream?.getTracks().forEach((track) => track.stop());
	stream = null;
	el.video.srcObject = null;
}

function fallbackToUpload(reason, loud = false) {
	stopCamera();
	el.dropnote.textContent = `${reason} Drop an image here, or choose one instead.`;
	setState("upload");
	if (loud) toastError(reason);
}

/**
 * The viewfinder is `object-fit: cover`, so the element shows a centred crop of
 * the camera frame — a 16:9 stream on a tall phone hides most of its width.
 * Capturing the raw frame would translate text the user never saw, so this
 * reproduces the same crop and the photo matches the preview on every shape.
 */
export function captureVisibleFrame(video) {
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

/* ------------------------------------------------------------------ wiring */

el.allowCamera.addEventListener("click", () => startCamera({ userInitiated: true }));
el.enableCamera.addEventListener("click", () => startCamera({ userInitiated: true }));

el.flip.addEventListener("click", () => {
	facing = facing === "environment" ? "user" : "environment";
	startCamera();
});

// Release the camera while backgrounded; pick it up again on return.
document.addEventListener("visibilitychange", () => {
	if (document.hidden) stopCamera();
	else if (stateIs("camera")) startCamera();
});
