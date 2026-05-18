import type { TemplateModel } from "../types";

type OpenCvModule = {
  matFromImageData: (imageData: ImageData) => any;
  Mat: new () => any;
  cvtColor: (...args: any[]) => void;
  GaussianBlur: (...args: any[]) => void;
  adaptiveThreshold: (...args: any[]) => void;
  COLOR_RGBA2GRAY: number;
  ADAPTIVE_THRESH_GAUSSIAN_C: number;
  THRESH_BINARY: number;
  BORDER_DEFAULT: number;
  Size: new (width: number, height: number) => any;
};

declare global {
  interface Window {
    cv?: OpenCvModule;
    Module?: {
      onRuntimeInitialized?: () => void;
    };
  }
}

let cvPromise: Promise<OpenCvModule | null> | null = null;

function loadOpenCvScript() {
  return new Promise<OpenCvModule | null>((resolve) => {
    if (typeof window === "undefined") {
      resolve(null);
      return;
    }

    if (window.cv?.matFromImageData) {
      resolve(window.cv);
      return;
    }

    const existing = document.querySelector<HTMLScriptElement>('script[data-opencv="true"]');
    if (existing) {
      const checkInterval = window.setInterval(() => {
        if (window.cv?.matFromImageData) {
          window.clearInterval(checkInterval);
          resolve(window.cv);
        }
      }, 200);
      window.setTimeout(() => {
        window.clearInterval(checkInterval);
        resolve(window.cv ?? null);
      }, 5000);
      return;
    }

    const script = document.createElement("script");
    script.src = "https://docs.opencv.org/4.x/opencv.js";
    script.async = true;
    script.defer = true;
    script.dataset.opencv = "true";
    script.onload = () => {
      const checkInterval = window.setInterval(() => {
        if (window.cv?.matFromImageData) {
          window.clearInterval(checkInterval);
          resolve(window.cv);
        }
      }, 200);
      window.setTimeout(() => {
        window.clearInterval(checkInterval);
        resolve(window.cv ?? null);
      }, 5000);
    };
    script.onerror = () => resolve(null);
    document.head.appendChild(script);
  });
}

async function getCv() {
  if (!cvPromise) {
    cvPromise = loadOpenCvScript();
  }
  return cvPromise;
}

export async function normalizeCanvasWithOpenCv(
  canvas: HTMLCanvasElement,
  template: TemplateModel
) {
  const cv = await getCv();
  if (!cv) {
    return canvas;
  }

  try {
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) {
      return canvas;
    }

    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    const src = cv.matFromImageData(imageData);
    const gray = new cv.Mat();
    const binary = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);
    cv.adaptiveThreshold(
      gray,
      binary,
      255,
      cv.ADAPTIVE_THRESH_GAUSSIAN_C,
      cv.THRESH_BINARY,
      Math.max(11, Math.round(template.threshold / 4) * 2 + 1),
      2
    );

    const output = document.createElement("canvas");
    output.width = canvas.width;
    output.height = canvas.height;
    const outContext = output.getContext("2d");
    if (!outContext) {
      src.delete();
      gray.delete();
      binary.delete();
      return canvas;
    }

    const resultImageData = new ImageData(
      new Uint8ClampedArray(binary.data.length * 4),
      binary.cols,
      binary.rows
    );

    for (let index = 0; index < binary.data.length; index += 1) {
      const value = binary.data[index];
      const offset = index * 4;
      resultImageData.data[offset] = value;
      resultImageData.data[offset + 1] = value;
      resultImageData.data[offset + 2] = value;
      resultImageData.data[offset + 3] = 255;
    }

    outContext.putImageData(resultImageData, 0, 0);
    src.delete();
    gray.delete();
    binary.delete();
    return output;
  } catch {
    return canvas;
  }
}
