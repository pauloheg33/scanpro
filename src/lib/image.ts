export function createId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

export async function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
}

export async function imageUrlToImageElement(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

export async function drawImageToCanvas(url: string, maxWidth = 1600) {
  const image = await imageUrlToImageElement(url);
  const scale = Math.min(1, maxWidth / image.width);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("Nao foi possivel criar contexto 2D");
  }
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export function canvasToDataUrl(canvas: HTMLCanvasElement, quality = 0.92) {
  return canvas.toDataURL("image/jpeg", quality);
}

export function captureVideoFrame(video: HTMLVideoElement) {
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("Nao foi possivel capturar a imagem");
  }
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export function getImageData(canvas: HTMLCanvasElement) {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("Nao foi possivel ler pixels da imagem");
  }
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

export function cropCanvasToRegion(
  canvas: HTMLCanvasElement,
  region: { x: number; y: number; width: number; height: number }
) {
  const target = document.createElement("canvas");
  target.width = Math.max(1, Math.round(canvas.width * region.width));
  target.height = Math.max(1, Math.round(canvas.height * region.height));
  const context = target.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("Nao foi possivel recortar a area do gabarito");
  }

  context.drawImage(
    canvas,
    Math.round(canvas.width * region.x),
    Math.round(canvas.height * region.y),
    Math.round(canvas.width * region.width),
    Math.round(canvas.height * region.height),
    0,
    0,
    target.width,
    target.height
  );

  return target;
}

export function detectInkBoundingRegion(
  canvas: HTMLCanvasElement,
  region: { x: number; y: number; width: number; height: number },
  options?: {
    expandX?: number;
    expandY?: number;
    minRowInk?: number;
    minColInk?: number;
    minWidthRatio?: number;
    minHeightRatio?: number;
    padX?: number;
    padY?: number;
  }
) {
  const {
    expandX = 0.045,
    expandY = 0.05,
    minRowInk = 0.08,
    minColInk = 0.06,
    minWidthRatio = 0.55,
    minHeightRatio = 0.55,
    padX = 0.012,
    padY = 0.012
  } = options ?? {};

  const expanded = {
    x: Math.max(0, region.x - expandX),
    y: Math.max(0, region.y - expandY),
    width: Math.min(1, region.width + expandX * 2),
    height: Math.min(1, region.height + expandY * 2)
  };
  if (expanded.x + expanded.width > 1) {
    expanded.width = 1 - expanded.x;
  }
  if (expanded.y + expanded.height > 1) {
    expanded.height = 1 - expanded.y;
  }

  const search = cropCanvasToRegion(canvas, expanded);
  const context = search.getContext("2d", { willReadFrequently: true });
  if (!context) {
    return region;
  }

  const { data, width, height } = context.getImageData(0, 0, search.width, search.height);
  const rowInk = new Array<number>(height).fill(0);
  const colInk = new Array<number>(width).fill(0);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const luminance =
        data[offset] * 0.299 + data[offset + 1] * 0.587 + data[offset + 2] * 0.114;
      const ink = luminance < 180 ? 1 : 0;
      rowInk[y] += ink;
      colInk[x] += ink;
    }
  }

  const rowThreshold = Math.max(1, Math.round(width * minRowInk));
  const colThreshold = Math.max(1, Math.round(height * minColInk));

  let top = rowInk.findIndex((value) => value >= rowThreshold);
  let bottom = rowInk.length - 1 - [...rowInk].reverse().findIndex((value) => value >= rowThreshold);
  let left = colInk.findIndex((value) => value >= colThreshold);
  let right = colInk.length - 1 - [...colInk].reverse().findIndex((value) => value >= colThreshold);

  if (top < 0 || left < 0 || bottom < top || right < left) {
    return region;
  }

  const detectedWidth = (right - left + 1) / width;
  const detectedHeight = (bottom - top + 1) / height;
  if (detectedWidth < minWidthRatio || detectedHeight < minHeightRatio) {
    return region;
  }

  const refined = {
    x: expanded.x + left / width * expanded.width - padX,
    y: expanded.y + top / height * expanded.height - padY,
    width: ((right - left + 1) / width) * expanded.width + padX * 2,
    height: ((bottom - top + 1) / height) * expanded.height + padY * 2
  };

  refined.x = Math.max(0, refined.x);
  refined.y = Math.max(0, refined.y);
  refined.width = Math.min(1 - refined.x, refined.width);
  refined.height = Math.min(1 - refined.y, refined.height);

  return refined;
}
