/**
 * Getting the PNG off the device.
 *
 * A desktop browser saves it from a download link. An iPhone is the hard
 * case: a download lands in the Files app's Downloads folder at best, where
 * nobody looks for a picture, and a Home Screen app may not download at
 * all. So a touch device that can share files uses the share sheet (Web
 * Share with files, in iOS Safari 15 and later and Android Chrome), which
 * offers Save Image, Save to Files and AirDrop. The download link is offered
 * beside it, and is all a device without file sharing gets.
 *
 * The share must start from a tap, and Safari allows only a moment between
 * the tap and the call. Making the image can take longer, so the image is
 * made first and a second tap shares it.
 */

export function prefersShare(file: File): boolean {
  if (typeof navigator.canShare !== "function" || typeof navigator.share !== "function") return false;
  // A desktop browser that can share files still saves through a download, which is what a desktop user expects.
  if (!matchMedia("(pointer: coarse)").matches) return false;
  try {
    return navigator.canShare({ files: [file] });
  } catch {
    return false;
  }
}

export type ShareResult = "shared" | "cancelled" | "failed";

export async function shareFile(file: File): Promise<ShareResult> {
  try {
    await navigator.share({ files: [file], title: file.name });
    return "shared";
  } catch (err) {
    // Closing the share sheet rejects with AbortError. That is a choice, not a failure.
    if (err instanceof DOMException && err.name === "AbortError") return "cancelled";
    return "failed";
  }
}
