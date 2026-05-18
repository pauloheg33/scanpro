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

