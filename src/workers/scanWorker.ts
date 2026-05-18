import { expose } from "comlink";
import type { ScanAnalysis, TemplateModel } from "../types";

type ScanWorkerInput = {
  pixels: Uint8ClampedArray;
  width: number;
  height: number;
  template: TemplateModel;
};

function getCellIntensity(
  pixels: Uint8ClampedArray,
  width: number,
  x: number,
  y: number,
  cellWidth: number,
  cellHeight: number
) {
  let darkness = 0;
  let total = 0;
  for (let row = y; row < y + cellHeight; row += 1) {
    for (let col = x; col < x + cellWidth; col += 1) {
      if (row < 0 || col < 0 || row >= Math.floor(pixels.length / 4 / width) || col >= width) {
        continue;
      }
      const offset = (row * width + col) * 4;
      const red = pixels[offset];
      const green = pixels[offset + 1];
      const blue = pixels[offset + 2];
      const luminance = red * 0.299 + green * 0.587 + blue * 0.114;
      darkness += 255 - luminance;
      total += 1;
    }
  }
  return total === 0 ? 0 : darkness / total / 255;
}

const api = {
  analyze({ pixels, width, height, template }: ScanWorkerInput): ScanAnalysis {
    const region = {
      x: Math.round(template.region.x * width),
      y: Math.round(template.region.y * height),
      width: Math.round(template.region.width * width),
      height: Math.round(template.region.height * height)
    };

    const rowsPerColumn = Math.ceil(template.questionCount / template.columnCount);
    const columnWidth =
      (region.width - Math.round(region.width * template.columnGapRatio) * (template.columnCount - 1)) /
      template.columnCount;
    const questionHeight =
      (region.height - Math.round(region.height * template.rowGapRatio) * (rowsPerColumn - 1)) /
      rowsPerColumn;
    const optionWidth = columnWidth / template.alternativesCount;

    const detectedAnswers: ScanAnalysis["detectedAnswers"] = [];
    const ambiguousQuestions: number[] = [];
    const blanks: number[] = [];
    const bubbleScores: number[][] = [];
    const debugOverlay: ScanAnalysis["debugOverlay"] = [];
    let confidenceAccumulator = 0;

    for (let questionIndex = 0; questionIndex < template.questionCount; questionIndex += 1) {
      const columnIndex = Math.floor(questionIndex / rowsPerColumn);
      const rowIndex = questionIndex % rowsPerColumn;
      const columnX =
        region.x + Math.round(columnIndex * (columnWidth + region.width * template.columnGapRatio));
      const rowY = region.y + Math.round(rowIndex * (questionHeight + region.height * template.rowGapRatio));
      const cellScores: number[] = [];

      for (let alternativeIndex = 0; alternativeIndex < template.alternativesCount; alternativeIndex += 1) {
        const cellX = Math.round(columnX + alternativeIndex * optionWidth);
        const cellWidth = Math.max(8, Math.round(optionWidth * 0.9));
        const cellHeight = Math.max(8, Math.round(questionHeight * 0.7));
        const cellY = Math.round(rowY + questionHeight * 0.15);
        const score = getCellIntensity(pixels, width, cellX, cellY, cellWidth, cellHeight);
        cellScores.push(score);
        debugOverlay.push({ questionIndex, alternativeIndex, score });
      }

      bubbleScores.push(cellScores);
      const sorted = [...cellScores].sort((left, right) => right - left);
      const best = sorted[0] ?? 0;
      const second = sorted[1] ?? 0;
      const bestIndex = cellScores.findIndex((value) => value === best);
      const confidence = Math.max(0, Math.min(1, best - second));
      confidenceAccumulator += confidence;

      if (best < 0.1) {
        blanks.push(questionIndex);
        detectedAnswers.push("A");
        continue;
      }

      if (best < template.minConfidence || best - second < template.minConfidence / 2) {
        ambiguousQuestions.push(questionIndex);
      }

      detectedAnswers.push(["A", "B", "C", "D", "E", "F"][bestIndex] as ScanAnalysis["detectedAnswers"][number]);
    }

    return {
      detectedAnswers,
      ambiguousQuestions,
      blanks,
      confidence: confidenceAccumulator / template.questionCount,
      bubbleScores,
      debugOverlay
    };
  }
};

export type ScanWorkerApi = typeof api;

expose(api);

