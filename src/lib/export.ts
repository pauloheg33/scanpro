import Papa from "papaparse";
import { db } from "./db";
import type { Lot, ScanRecord, Student, TemplateModel } from "../types";

function downloadTextFile(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export async function exportLotCsv(
  lot: Lot,
  scans: ScanRecord[],
  students: Student[]
) {
  const rows = scans.map((scan) => {
    const student = students.find((item) => item.id === scan.studentId);
    return {
      aluno: student?.name ?? "Sem aluno",
      percentual: scan.percent,
      acertos: scan.correctCount,
      confianca: Number(scan.confidence.toFixed(2)),
      respostas_detectadas: scan.detectedAnswers.join(""),
      respostas_finais: scan.finalAnswers.join(""),
      ambiguas: scan.ambiguousQuestions.map((value) => value + 1).join(", "),
      brancos: scan.blanks.map((value) => value + 1).join(", "),
      criado_em: scan.createdAt
    };
  });

  const csv = Papa.unparse(rows);
  downloadTextFile(`${lot.name}-resultados.csv`, csv, "text/csv;charset=utf-8");
}

export async function exportBackupJson() {
  const [templates, lots, students, scans] = await Promise.all([
    db.templates.toArray(),
    db.lots.toArray(),
    db.students.toArray(),
    db.scans.toArray()
  ]);

  downloadTextFile(
    `scanpro-backup-${new Date().toISOString().slice(0, 10)}.json`,
    JSON.stringify({ templates, lots, students, scans }, null, 2),
    "application/json"
  );
}

export async function importBackupJson(file: File) {
  const text = await file.text();
  const payload = JSON.parse(text) as {
    templates: TemplateModel[];
    lots: Lot[];
    students: Student[];
    scans: ScanRecord[];
  };

  await db.transaction("rw", db.templates, db.lots, db.students, db.scans, async () => {
    await db.templates.bulkPut(payload.templates);
    await db.lots.bulkPut(payload.lots);
    await db.students.bulkPut(payload.students);
    await db.scans.bulkPut(payload.scans);
  });
}

