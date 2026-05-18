import type { BookletDetection } from "../types";

let tesseractModulePromise: Promise<typeof import("tesseract.js") | null> | null = null;

async function getTesseract() {
  if (!tesseractModulePromise) {
    tesseractModulePromise = import("tesseract.js").catch(() => null);
  }
  return tesseractModulePromise;
}

function cleanBookletText(value: string) {
  return value
    .toUpperCase()
    .replace(/O/g, "0")
    .replace(/I/g, "1")
    .replace(/[^A-Z0-9]/g, " ");
}

function extractBookletCode(rawText: string) {
  const normalized = cleanBookletText(rawText);
  const matches = normalized.match(/\b[PMN][0-9]{4}\b/g);
  return matches?.[0] ?? null;
}

export async function detectBookletCodeFromCanvas(
  canvas: HTMLCanvasElement
): Promise<BookletDetection> {
  const tesseract = await getTesseract();
  if (!tesseract) {
    return { code: null, rawText: "" };
  }

  const crop = document.createElement("canvas");
  crop.width = canvas.width;
  crop.height = Math.max(1, Math.round(canvas.height * 0.26));
  const context = crop.getContext("2d", { willReadFrequently: true });
  if (!context) {
    return { code: null, rawText: "" };
  }

  context.drawImage(canvas, 0, 0, canvas.width, crop.height, 0, 0, crop.width, crop.height);

  try {
    const result = await tesseract.recognize(crop, "eng", {
      logger: () => undefined
    });
    const rawText = result.data.text ?? "";
    return {
      code: extractBookletCode(rawText),
      rawText
    };
  } catch {
    return { code: null, rawText: "" };
  }
}
