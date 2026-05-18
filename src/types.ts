export type AlternativeLabel = "A" | "B" | "C" | "D" | "E" | "F";

export type TemplateModel = {
  id: string;
  name: string;
  family?: string;
  gradeLabel?: string;
  subjectLabel?: string;
  bookletCode?: string;
  questionCount: number;
  alternativesCount: number;
  columnCount: number;
  rowGapRatio: number;
  columnGapRatio: number;
  region: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  threshold: number;
  minConfidence: number;
  createdAt: string;
};

export type Lot = {
  id: string;
  name: string;
  className: string;
  templateId: string;
  questionCount: number;
  alternativesCount: number;
  expectedStudentCount: number;
  answerKey: AlternativeLabel[];
  createdAt: string;
  status: "draft" | "active" | "completed";
};

export type Student = {
  id: string;
  lotId: string;
  name: string;
  createdAt: string;
};

export type ScanRecord = {
  id: string;
  lotId: string;
  studentId: string;
  templateId: string;
  sourceImage: string;
  normalizedImage: string;
  detectedAnswers: AlternativeLabel[];
  finalAnswers: AlternativeLabel[];
  ambiguousQuestions: number[];
  blanks: number[];
  percent: number;
  correctCount: number;
  confidence: number;
  status: "pending-review" | "confirmed";
  createdAt: string;
};

export type PendingScan = {
  lot: Lot;
  template: TemplateModel;
  detectedBookletCode?: string;
  imageUrl: string;
  normalizedImage: string;
  detectedAnswers: AlternativeLabel[];
  finalAnswers: AlternativeLabel[];
  ambiguousQuestions: number[];
  blanks: number[];
  percent: number;
  correctCount: number;
  confidence: number;
};

export type ScanAnalysis = {
  detectedAnswers: AlternativeLabel[];
  ambiguousQuestions: number[];
  blanks: number[];
  confidence: number;
  bubbleScores: number[][];
  debugOverlay: Array<{
    questionIndex: number;
    alternativeIndex: number;
    score: number;
  }>;
};

export const alternativeLabels: AlternativeLabel[] = ["A", "B", "C", "D", "E", "F"];

export type BookletDetection = {
  code: string | null;
  rawText: string;
};
