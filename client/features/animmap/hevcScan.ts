import { HEVC_ENTRIES, scanRanges, videoSampleEntry, type FilePart } from "#shared/video/hevcScan.ts";

/** The device half of the HEVC scan (AMROT-O-06): it reads the file's two ends and hands them to the shared scan (shared/video/hevcScan.ts). */

/** Reads the parts of `file` that `scanRanges` names and finds its first video track's sample entry, or null when they do not decide it. */
export async function readVideoSampleEntry(file: Pick<Blob, "size" | "slice">): Promise<string | null> {
  try {
    const parts = await Promise.all(scanRanges(file.size).map(async ([start, end]): Promise<FilePart> => ({ start, bytes: new Uint8Array(await file.slice(start, end).arrayBuffer()) })));
    return videoSampleEntry(parts, file.size);
  } catch {
    // A file this browser cannot read here is the probe's and the server's to judge.
    return null;
  }
}

/** Whether `file`'s first and last MiB show it is HEVC, which the server refuses. */
export async function isHevc(file: Pick<Blob, "size" | "slice">): Promise<boolean> {
  const entry = await readVideoSampleEntry(file);
  return entry !== null && HEVC_ENTRIES.has(entry);
}
