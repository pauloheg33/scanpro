import Dexie, { type Table } from "dexie";
import type { Lot, ScanRecord, Student, TemplateModel } from "../types";

class ScanproDatabase extends Dexie {
  templates!: Table<TemplateModel, string>;
  lots!: Table<Lot, string>;
  students!: Table<Student, string>;
  scans!: Table<ScanRecord, string>;

  constructor() {
    super("scanpro-db");
    this.version(1).stores({
      templates: "id, name, createdAt",
      lots: "id, name, templateId, createdAt, status",
      students: "id, lotId, name, createdAt",
      scans: "id, lotId, studentId, templateId, createdAt, status"
    });
  }
}

export const db = new ScanproDatabase();

