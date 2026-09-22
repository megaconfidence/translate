/**
 * Pixel work, kept on the client so the Worker never spends CPU on images.
 */

/** Longest edge we upload. Larger costs latency and bytes, not accuracy. */
const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.85;

/**
 * `from-image` applies the EXIF rotation, so a sideways phone photo is upright
 * before OCR sees it. Without it every bounding box would come back rotated.
 */
export function bitmapFromFile(file) {
	return createImageBitmap(file, { imageOrientation: "from-image" });
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

function toJpegDataUrl(bitmap) {
	const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
	canvas.getContext("2d").drawImage(bitmap, 0, 0);
	return canvas
		.convertToBlob({ type: "image/jpeg", quality: JPEG_QUALITY })
		.then(
			(blob) =>
				new Promise((resolve, reject) => {
					const reader = new FileReader();
					reader.onload = () => resolve(reader.result);
					reader.onerror = () => reject(new Error("could not encode image"));
					reader.readAsDataURL(blob);
				}),
		);
}

/**
 * Shrink and encode in one step. The returned bitmap is exactly what the data
 * URL contains, which is what lets OCR coordinates map straight onto the photo
 * we display.
 */
export async function prepareForUpload(sourceBitmap) {
	const bitmap = await downscale(sourceBitmap);
	return { bitmap, dataUrl: await toJpegDataUrl(bitmap) };
}
