import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type TempImageInput = {
  base64: string;
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
};

export type TempImages = {
  paths: string[];
  cleanup: () => void;
};

export function writeTempImages(prefix: string, images?: TempImageInput[]): TempImages | null {
  if (!images || images.length === 0) {
    return null;
  }

  const tempDir = join(tmpdir(), `${prefix}-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });

  const paths: string[] = [];
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    if (!img) continue;
    const ext = img.mediaType.split("/")[1] ?? "jpg";
    const tempPath = join(tempDir, `image-${i}.${ext}`);
    writeFileSync(tempPath, Buffer.from(img.base64, "base64"));
    paths.push(tempPath);
  }

  const cleanup = () => {
    try {
      rmSync(tempDir, { recursive: true });
    } catch {
      // ignore cleanup errors
    }
  };

  return { paths, cleanup };
}
