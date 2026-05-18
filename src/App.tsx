import { useEffect, useMemo, useRef, useState } from "react";
import { db } from "./lib/db";
import { exportBackupJson, exportLotCsv, importBackupJson } from "./lib/export";
import {
  canvasToDataUrl,
  createId,
  cropCanvasToRegion,
  detectInkBoundingRegion,
  drawImageToCanvas,
  fileToDataUrl,
  getImageData
} from "./lib/image";
import { normalizeCanvasWithOpenCv } from "./lib/opencv";
import { getScanWorker } from "./lib/scan-worker-client";
import { useAppStore } from "./store/useAppStore";
import type {
  AlternativeLabel,
  Lot,
  PendingScan,
  ScanRecord,
  Student,
  TemplateModel
} from "./types";
import { alternativeLabels } from "./types";

type TemplateDraft = {
  name: string;
  questionCount: number;
  alternativesCount: number;
  columnCount: number;
  regionX: number;
  regionY: number;
  regionWidth: number;
  regionHeight: number;
  rowGapRatio: number;
  columnGapRatio: number;
  threshold: number;
  minConfidence: number;
};

type LotDraft = {
  name: string;
  className: string;
  templateId: string;
  expectedStudentCount: number;
  answerKey: string;
  roster: string;
};

type AppView = "operacao" | "lotes" | "modelos" | "resultados";

type CropRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type CaptureDraft = {
  lot: Lot;
  template: TemplateModel;
  fileName: string;
  fileSizeKb: number;
  imageUrl: string;
  normalizedImage: string;
  suggestedCrop: CropRect;
  confirmedCrop: CropRect;
};

type DragMode = "move" | "se" | "sw" | "ne" | "nw";

const MIN_CROP_SIZE = 0.16;

const defaultTemplateDraft: TemplateDraft = {
  name: "",
  questionCount: 20,
  alternativesCount: 5,
  columnCount: 2,
  regionX: 0.2,
  regionY: 0.18,
  regionWidth: 0.62,
  regionHeight: 0.68,
  rowGapRatio: 0.015,
  columnGapRatio: 0.05,
  threshold: 31,
  minConfidence: 0.11
};

const defaultLotDraft: LotDraft = {
  name: "",
  className: "",
  templateId: "",
  expectedStudentCount: 30,
  answerKey: "",
  roster: ""
};

const proeaTemplatePresetsSource: Array<[string, string, string, number]> = [
  ["6º ano", "Língua Portuguesa", "P0602", 26],
  ["6º ano", "Matemática", "M0602", 26],
  ["6º ano", "Ciências da Natureza", "N0602", 27],
  ["7º ano", "Língua Portuguesa", "P0702", 26],
  ["7º ano", "Matemática", "M0702", 26],
  ["7º ano", "Ciências da Natureza", "N0702", 27],
  ["8º ano", "Língua Portuguesa", "P0802", 26],
  ["8º ano", "Matemática", "M0802", 26],
  ["8º ano", "Ciências da Natureza", "N0802", 27],
  ["9º ano", "Língua Portuguesa", "P0902", 26],
  ["9º ano", "Matemática", "M0902", 26],
  ["9º ano", "Ciências da Natureza", "N0902", 27]
];

const proeaTemplatePresets: Array<
  Omit<TemplateModel, "createdAt"> & { id: string }
> = proeaTemplatePresetsSource.map(([gradeLabel, subjectLabel, bookletCode, questionCount]) => ({
  id: `proea-${bookletCode.toLowerCase()}`,
  name: `PROEA ${gradeLabel} - ${subjectLabel}`,
  family: "PROEA Anos Finais 2026",
  gradeLabel,
  subjectLabel,
  bookletCode,
  questionCount,
  alternativesCount: 4,
  columnCount: questionCount === 27 ? 3 : 4,
  rowGapRatio: 0.015,
  columnGapRatio: 0.045,
  region:
    questionCount === 27
      ? { x: 0.14, y: 0.624, width: 0.793, height: 0.266 }
      : { x: 0.121, y: 0.645, width: 0.83, height: 0.228 },
  threshold: 31,
  minConfidence: 0.11
}));

function scoreAnswers(detectedAnswers: AlternativeLabel[], answerKey: AlternativeLabel[]) {
  let correctCount = 0;
  for (let index = 0; index < answerKey.length; index += 1) {
    if (detectedAnswers[index] === answerKey[index]) {
      correctCount += 1;
    }
  }
  return {
    correctCount,
    percent: answerKey.length === 0 ? 0 : Number(((correctCount / answerKey.length) * 100).toFixed(2))
  };
}

function toAnswerKey(value: string, expectedLength: number, alternativesCount: number) {
  const filtered = value
    .toUpperCase()
    .replace(/[^A-F]/g, "")
    .slice(0, expectedLength)
    .split("") as AlternativeLabel[];
  const allowed = alternativeLabels.slice(0, alternativesCount);
  return filtered.filter((item) => allowed.includes(item));
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short"
  }).format(new Date(value));
}

function clampCrop(crop: CropRect): CropRect {
  const width = Math.min(1, Math.max(MIN_CROP_SIZE, crop.width));
  const height = Math.min(1, Math.max(MIN_CROP_SIZE, crop.height));
  const x = Math.min(1 - width, Math.max(0, crop.x));
  const y = Math.min(1 - height, Math.max(0, crop.y));
  return { x, y, width, height };
}

function createProeaSeedRows() {
  const createdAt = new Date().toISOString();
  return proeaTemplatePresets.map((preset) => ({
    ...preset,
    createdAt
  }));
}

export default function App() {
  const [templates, setTemplates] = useState<TemplateModel[]>([]);
  const [lots, setLots] = useState<Lot[]>([]);
  const [students, setStudents] = useState<Student[]>([]);
  const [scans, setScans] = useState<ScanRecord[]>([]);
  const [templateDraft, setTemplateDraft] = useState<TemplateDraft>(defaultTemplateDraft);
  const [lotDraft, setLotDraft] = useState<LotDraft>(defaultLotDraft);
  const [loading, setLoading] = useState(true);
  const [busyMessage, setBusyMessage] = useState("");
  const [notice, setNotice] = useState("");
  const [activeView, setActiveView] = useState<AppView>("operacao");
  const [captureMessage, setCaptureMessage] = useState(
    "Escolha um lote e fotografe somente a area do gabarito."
  );
  const [selectedStudentId, setSelectedStudentId] = useState("");
  const [activePreviewTemplateId, setActivePreviewTemplateId] = useState("");
  const [captureDraft, setCaptureDraft] = useState<CaptureDraft | null>(null);
  const [operationStage, setOperationStage] = useState<
    "idle" | "photo-received" | "crop-ready" | "analyzing" | "review-ready"
  >("idle");
  const selectedLotId = useAppStore((state) => state.selectedLotId);
  const pendingScan = useAppStore((state) => state.pendingScan);
  const setSelectedLotId = useAppStore((state) => state.setSelectedLotId);
  const setPendingScan = useAppStore((state) => state.setPendingScan);
  const captureInputRef = useRef<HTMLInputElement | null>(null);
  const galleryInputRef = useRef<HTMLInputElement | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const operationFocusRef = useRef<HTMLDivElement | null>(null);

  const selectedLot = useMemo(
    () => lots.find((lot) => lot.id === selectedLotId) ?? null,
    [lots, selectedLotId]
  );
  const selectedTemplate = useMemo(
    () =>
      templates.find((template) =>
        template.id === (selectedLot?.templateId || activePreviewTemplateId)
      ) ?? null,
    [activePreviewTemplateId, selectedLot?.templateId, templates]
  );
  const lotStudents = useMemo(
    () => students.filter((student) => student.lotId === selectedLotId),
    [selectedLotId, students]
  );
  const lotScans = useMemo(
    () => scans.filter((scan) => scan.lotId === selectedLotId),
    [scans, selectedLotId]
  );
  const selectedStudentScanIds = useMemo(
    () => new Set(lotScans.map((item) => item.studentId)),
    [lotScans]
  );

  useEffect(() => {
    async function loadAll() {
      const [nextTemplates, nextLots, nextStudents, nextScans] = await Promise.all([
        db.templates.orderBy("createdAt").reverse().toArray(),
        db.lots.orderBy("createdAt").reverse().toArray(),
        db.students.orderBy("createdAt").toArray(),
        db.scans.orderBy("createdAt").reverse().toArray()
      ]);

      if (nextTemplates.length === 0) {
        await db.templates.bulkPut(createProeaSeedRows());
      }

      const [finalTemplates, finalLots, finalStudents, finalScans] = await Promise.all([
        db.templates.orderBy("createdAt").reverse().toArray(),
        db.lots.orderBy("createdAt").reverse().toArray(),
        db.students.orderBy("createdAt").toArray(),
        db.scans.orderBy("createdAt").reverse().toArray()
      ]);

      setTemplates(finalTemplates);
      setLots(finalLots);
      setStudents(finalStudents);
      setScans(finalScans);
      if (!selectedLotId && finalLots[0]) {
        setSelectedLotId(finalLots[0].id);
      }
      if (nextTemplates.length === 0) {
        setNotice("Modelos PROEA carregados automaticamente para a operacao.");
      }
      setLoading(false);
    }

    void loadAll();
  }, [selectedLotId, setSelectedLotId]);

  useEffect(() => {
    if (!captureDraft && !pendingScan) {
      return;
    }
    const node = operationFocusRef.current;
    if (!node) {
      return;
    }
    window.setTimeout(() => {
      node.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 120);
  }, [captureDraft, pendingScan]);

  async function refreshAll() {
    const [nextTemplates, nextLots, nextStudents, nextScans] = await Promise.all([
      db.templates.orderBy("createdAt").reverse().toArray(),
      db.lots.orderBy("createdAt").reverse().toArray(),
      db.students.orderBy("createdAt").toArray(),
      db.scans.orderBy("createdAt").reverse().toArray()
    ]);
    setTemplates(nextTemplates);
    setLots(nextLots);
    setStudents(nextStudents);
    setScans(nextScans);
  }

  async function saveTemplate() {
    const template: TemplateModel = {
      id: createId("tpl"),
      name: templateDraft.name || `Modelo ${templates.length + 1}`,
      questionCount: templateDraft.questionCount,
      alternativesCount: templateDraft.alternativesCount,
      columnCount: templateDraft.columnCount,
      rowGapRatio: templateDraft.rowGapRatio,
      columnGapRatio: templateDraft.columnGapRatio,
      region: {
        x: templateDraft.regionX,
        y: templateDraft.regionY,
        width: templateDraft.regionWidth,
        height: templateDraft.regionHeight
      },
      threshold: templateDraft.threshold,
      minConfidence: templateDraft.minConfidence,
      createdAt: new Date().toISOString()
    };

    await db.templates.add(template);
    setTemplateDraft(defaultTemplateDraft);
    setActivePreviewTemplateId(template.id);
    setNotice("Modelo salvo com sucesso.");
    await refreshAll();
  }

  async function seedProeaTemplates() {
    await db.templates.bulkPut(createProeaSeedRows());
    setNotice("Modelos PROEA 6º ao 9º carregados na base local.");
    await refreshAll();
  }

  async function saveLot() {
    const template = templates.find((item) => item.id === lotDraft.templateId);
    if (!template) {
      throw new Error("Escolha um modelo antes de criar o lote.");
    }
    const answerKey = toAnswerKey(
      lotDraft.answerKey,
      template.questionCount,
      template.alternativesCount
    );
    if (answerKey.length !== template.questionCount) {
      throw new Error("O gabarito precisa ter exatamente uma letra por questao.");
    }

    const lotId = createId("lot");
    const createdAt = new Date().toISOString();
    const lot: Lot = {
      id: lotId,
      name: lotDraft.name || `Lote ${lots.length + 1}`,
      className: lotDraft.className || "Turma",
      templateId: template.id,
      questionCount: template.questionCount,
      alternativesCount: template.alternativesCount,
      expectedStudentCount: lotDraft.expectedStudentCount,
      answerKey,
      createdAt,
      status: "active"
    };

    const roster = lotDraft.roster
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean);
    const studentsToCreate =
      roster.length > 0
        ? roster
        : Array.from({ length: lotDraft.expectedStudentCount }, (_, index) => `Aluno ${index + 1}`);

    const studentRows: Student[] = studentsToCreate.map((name) => ({
      id: createId("std"),
      lotId,
      name,
      createdAt
    }));

    await db.transaction("rw", db.lots, db.students, async () => {
      await db.lots.add(lot);
      await db.students.bulkAdd(studentRows);
    });

    setLotDraft(defaultLotDraft);
    setSelectedLotId(lotId);
    setNotice("Lote criado e pronto para leitura manual do gabarito.");
    await refreshAll();
  }

  async function prepareCapture(file: File) {
    if (!selectedLot || !selectedTemplate) {
      throw new Error("Escolha um lote com modelo definido antes de fotografar.");
    }

    setOperationStage("photo-received");
    setBusyMessage("Preparando a foto do gabarito...");
    const imageUrl = await fileToDataUrl(file);
    const originalCanvas = await drawImageToCanvas(imageUrl);
    const normalizedCanvas = await normalizeCanvasWithOpenCv(originalCanvas, selectedTemplate);
    const suggestedCrop = clampCrop(
      detectInkBoundingRegion(normalizedCanvas, selectedTemplate.region, {
        expandX: 0.035,
        expandY: 0.04,
        minRowInk: 0.05,
        minColInk: 0.05,
        minWidthRatio: 0.58,
        minHeightRatio: 0.58,
        padX: 0.01,
        padY: 0.01
      })
    );

    setCaptureDraft({
      lot: selectedLot,
      template: selectedTemplate,
      fileName: file.name || "foto-do-gabarito.jpg",
      fileSizeKb: Math.max(1, Math.round(file.size / 1024)),
      imageUrl,
      normalizedImage: canvasToDataUrl(normalizedCanvas),
      suggestedCrop,
      confirmedCrop: suggestedCrop
    });
    setBusyMessage("");
    setNotice("Foto recebida com sucesso. Agora ajuste o recorte do gabarito.");
    setOperationStage("crop-ready");
    setCaptureMessage("Ajuste o recorte para conter apenas o bloco do gabarito e confirme a analise.");
    setPendingScan(null);
    setSelectedStudentId("");
  }

  async function analyzeConfirmedCrop() {
    if (!captureDraft) {
      return;
    }

    setOperationStage("analyzing");
    setBusyMessage("Recortando o bloco confirmado do gabarito...");
    const normalizedCanvas = await drawImageToCanvas(captureDraft.normalizedImage);
    const finalCrop = clampCrop(captureDraft.confirmedCrop);
    const answerRegionCanvas = cropCanvasToRegion(normalizedCanvas, finalCrop);
    const imageData = getImageData(answerRegionCanvas);
    const worker = await getScanWorker();
    setBusyMessage("Lendo as respostas marcadas...");
    const analysis = await worker.analyze({
      pixels: imageData.data,
      width: imageData.width,
      height: imageData.height,
      template: {
        ...captureDraft.template,
        region: {
          x: 0,
          y: 0,
          width: 1,
          height: 1
        }
      }
    });

    const score = scoreAnswers(analysis.detectedAnswers, captureDraft.lot.answerKey);
    const nextPending: PendingScan = {
      lot: captureDraft.lot,
      template: captureDraft.template,
      imageUrl: captureDraft.imageUrl,
      normalizedImage: canvasToDataUrl(answerRegionCanvas),
      suggestedCrop: captureDraft.suggestedCrop,
      confirmedCrop: finalCrop,
      detectedAnswers: analysis.detectedAnswers,
      finalAnswers: [...analysis.detectedAnswers],
      ambiguousQuestions: analysis.ambiguousQuestions,
      blanks: analysis.blanks,
      correctCount: score.correctCount,
      percent: score.percent,
      confidence: analysis.confidence
    };

    setPendingScan(nextPending);
    setCaptureDraft(null);
    setBusyMessage("");
    setNotice("Analise concluida. Confira as respostas detectadas abaixo.");
    setOperationStage("review-ready");
    setCaptureMessage("Leitura pronta. Confira as respostas e confirme o aluno.");
  }

  async function confirmPendingScan() {
    if (!pendingScan || !selectedStudentId) {
      return;
    }

    const score = scoreAnswers(pendingScan.finalAnswers, pendingScan.lot.answerKey);
    const scan: ScanRecord = {
      id: createId("scan"),
      lotId: pendingScan.lot.id,
      templateId: pendingScan.template.id,
      studentId: selectedStudentId,
      sourceImage: pendingScan.imageUrl,
      normalizedImage: pendingScan.normalizedImage,
      detectedAnswers: pendingScan.detectedAnswers,
      finalAnswers: pendingScan.finalAnswers,
      ambiguousQuestions: pendingScan.ambiguousQuestions,
      blanks: pendingScan.blanks,
      percent: score.percent,
      correctCount: score.correctCount,
      confidence: pendingScan.confidence,
      status: pendingScan.ambiguousQuestions.length > 0 ? "pending-review" : "confirmed",
      createdAt: new Date().toISOString()
    };

    await db.scans.put(scan);
    setPendingScan(null);
    setSelectedStudentId("");
    setNotice("Leitura confirmada e salva na base local.");
    setOperationStage("idle");
    setCaptureMessage("Leitura salva. Fotografe o proximo gabarito.");
    await refreshAll();
  }

  function updatePendingAnswer(questionIndex: number, answer: AlternativeLabel) {
    if (!pendingScan) {
      return;
    }
    const nextAnswers = [...pendingScan.finalAnswers];
    nextAnswers[questionIndex] = answer;
    const score = scoreAnswers(nextAnswers, pendingScan.lot.answerKey);
    setPendingScan({
      ...pendingScan,
      finalAnswers: nextAnswers,
      correctCount: score.correctCount,
      percent: score.percent
    });
  }

  async function onImportBackup(file: File) {
    setBusyMessage("Importando backup local...");
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

    setBusyMessage("");
    setNotice("Backup importado com sucesso.");
    await refreshAll();
  }

  async function safely(action: () => Promise<void>) {
    try {
      await action();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Ocorreu um erro inesperado.";
      setNotice(message);
      setBusyMessage("");
      setOperationStage("idle");
      console.error(error);
    }
  }

  const overview = useMemo(() => {
    const average =
      scans.length === 0
        ? 0
        : Number((scans.reduce((sum, item) => sum + item.percent, 0) / scans.length).toFixed(1));
    return {
      templates: templates.length,
      lots: lots.length,
      scans: scans.length,
      average
    };
  }, [lots.length, scans, templates.length]);

  if (loading) {
    return (
      <main className="shell">
        <section className="app-topbar">
          <div className="brand-block">
            <p className="eyebrow">iPhone-first OMR</p>
            <h1>SCANPRO</h1>
            <p>Carregando base local...</p>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="shell">
      <section className="app-topbar">
        <div className="brand-block">
          <p className="eyebrow">iPhone-first OMR</p>
          <h1>SCANPRO</h1>
          <p className="hero-copy">
            Fotografe apenas a area do gabarito, ajuste o recorte e deixe o app ler a grade PROEA.
          </p>
        </div>
        <div className="hero-stats compact">
          <MetricCard label="Modelos" value={String(overview.templates)} />
          <MetricCard label="Lotes" value={String(overview.lots)} />
          <MetricCard label="Leituras" value={String(overview.scans)} />
          <MetricCard label="Media geral" value={`${overview.average}%`} />
        </div>
      </section>

      <nav className="app-nav">
        <button
          className={`nav-pill ${activeView === "operacao" ? "active" : ""}`}
          onClick={() => setActiveView("operacao")}
        >
          Operacao
        </button>
        <button
          className={`nav-pill ${activeView === "lotes" ? "active" : ""}`}
          onClick={() => setActiveView("lotes")}
        >
          Lotes
        </button>
        <button
          className={`nav-pill ${activeView === "modelos" ? "active" : ""}`}
          onClick={() => setActiveView("modelos")}
        >
          Modelos
        </button>
        <button
          className={`nav-pill ${activeView === "resultados" ? "active" : ""}`}
          onClick={() => setActiveView("resultados")}
        >
          Resultados
        </button>
      </nav>

      {notice ? <div className="notice">{notice}</div> : null}

      {activeView === "operacao" ? (
        <section className="grid two operation-grid">
          <Card
            title="Fotografar gabarito"
            description="Use a camera nativa do iPhone ou a galeria. A foto deve mostrar somente a area do gabarito."
          >
            <div className="stage-strip">
              <div className={`stage-pill ${operationStage === "idle" ? "active" : ""}`}>1. Foto</div>
              <div className={`stage-pill ${operationStage === "photo-received" || operationStage === "crop-ready" ? "active" : ""}`}>2. Recorte</div>
              <div className={`stage-pill ${operationStage === "analyzing" ? "active" : ""}`}>3. Analise</div>
              <div className={`stage-pill ${operationStage === "review-ready" ? "active" : ""}`}>4. Revisao</div>
            </div>

            <div className="operation-banner three">
              <div>
                <strong>Lote ativo</strong>
                <p>{selectedLot ? `${selectedLot.name} • ${selectedLot.className}` : "Nenhum lote selecionado"}</p>
              </div>
              <div>
                <strong>Modelo do lote</strong>
                <p>{selectedTemplate ? selectedTemplate.name : "Escolha um modelo no lote"}</p>
              </div>
              <div>
                <strong>Guia operacional</strong>
                <p>Capture apenas o bloco com as alternativas marcadas.</p>
              </div>
            </div>

            <div className="capture-toolbar">
              <button
                className="primary"
                disabled={!selectedLot || !selectedTemplate || Boolean(captureDraft)}
                onClick={() => captureInputRef.current?.click()}
              >
                Fotografar gabarito
              </button>
              <button
                className="secondary"
                disabled={!selectedLot || !selectedTemplate || Boolean(captureDraft)}
                onClick={() => galleryInputRef.current?.click()}
              >
                Escolher da galeria
              </button>
              <input
                ref={captureInputRef}
                hidden
                type="file"
                accept="image/*"
                capture="environment"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) {
                    void safely(() => prepareCapture(file));
                  }
                  event.target.value = "";
                }}
              />
              <input
                ref={galleryInputRef}
                hidden
                type="file"
                accept="image/*"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) {
                    void safely(() => prepareCapture(file));
                  }
                  event.target.value = "";
                }}
              />
            </div>

            <div className="capture-manual">
              <div className="manual-frame">
                <div className="manual-answer-block">
                  <span>A</span>
                  <span>B</span>
                  <span>C</span>
                  <span>D</span>
                </div>
              </div>
              <div>
                <strong>Como fotografar</strong>
                <p>{captureMessage}</p>
                {busyMessage ? <p className="hint">{busyMessage}</p> : null}
                <p className="hint">
                  Evite fotografar nome, cabecalho e margens da folha. Quanto mais enxuto for o recorte
                  da foto, melhor a leitura da grade.
                </p>
              </div>
            </div>
          </Card>

          <Card
            title={captureDraft ? "Recorte do gabarito" : pendingScan ? "Conferencia das respostas" : "Fluxo da leitura"}
            description={
              captureDraft
                ? "Arraste ou redimensione o retangulo para cobrir somente o bloco do gabarito."
                : pendingScan
                  ? "Ajuste respostas ambíguas, selecione o aluno e confirme."
                  : "Depois da foto, o sistema vai sugerir um recorte e so entao analisar o gabarito."
            }
          >
            <div ref={operationFocusRef} />
            {captureDraft ? (
              <>
                <div className="receipt-card">
                  <strong>Foto recebida</strong>
                  <p>{captureDraft.fileName}</p>
                  <p>{captureDraft.fileSizeKb} KB • modelo {captureDraft.template.name}</p>
                </div>
                <CropEditor
                  imageUrl={captureDraft.normalizedImage}
                  crop={captureDraft.confirmedCrop}
                  suggestedCrop={captureDraft.suggestedCrop}
                  onChange={(nextCrop) =>
                    setCaptureDraft((current) =>
                      current
                        ? {
                            ...current,
                            confirmedCrop: clampCrop(nextCrop)
                          }
                        : current
                    )
                  }
                />
                <div className="capture-toolbar">
                  <button
                    className="secondary"
                    onClick={() => {
                      setCaptureDraft(null);
                      setOperationStage("idle");
                      setCaptureMessage("Capture novamente somente o bloco do gabarito.");
                    }}
                  >
                    Refazer foto
                  </button>
                  <button className="secondary" onClick={() =>
                    setCaptureDraft((current) =>
                      current
                        ? {
                            ...current,
                            confirmedCrop: current.suggestedCrop
                          }
                        : current
                    )
                  }>
                    Voltar sugestao
                  </button>
                  <button className="primary" onClick={() => void safely(analyzeConfirmedCrop)}>
                    Analisar gabarito
                  </button>
                </div>
              </>
            ) : pendingScan ? (
              <>
                <div className="receipt-card success">
                  <strong>Leitura gerada</strong>
                  <p>O gabarito foi analisado. Agora confira e confirme o aluno.</p>
                </div>
                <div className="preview-grid">
                  <img src={pendingScan.imageUrl} alt="Foto original do gabarito" />
                  <img src={pendingScan.normalizedImage} alt="Recorte usado para leitura" />
                </div>
                <div className="scan-summary">
                  <MetricCard label="Acertos" value={String(pendingScan.correctCount)} />
                  <MetricCard label="Percentual" value={`${pendingScan.percent}%`} />
                  <MetricCard label="Confianca" value={`${Math.round(pendingScan.confidence * 100)}%`} />
                  <MetricCard
                    label="Revisar"
                    value={String(new Set([...pendingScan.ambiguousQuestions, ...pendingScan.blanks]).size)}
                  />
                </div>
                <div className="note-block">
                  <strong>Leitura focada no bloco do gabarito</strong>
                  <p>{pendingScan.template.name}</p>
                  <p>O sistema analisou apenas o recorte confirmado da grade de respostas.</p>
                </div>
                <label>
                  Aluno do lote
                  <select
                    value={selectedStudentId}
                    onChange={(event) => setSelectedStudentId(event.target.value)}
                  >
                    <option value="">Selecione o aluno</option>
                    {lotStudents.map((student) => (
                      <option
                        key={student.id}
                        value={student.id}
                        disabled={selectedStudentScanIds.has(student.id)}
                      >
                        {student.name}
                        {selectedStudentScanIds.has(student.id) ? " (ja lido)" : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="answers-grid">
                  {pendingScan.finalAnswers.map((answer, index) => {
                    const needsReview =
                      pendingScan.ambiguousQuestions.includes(index) || pendingScan.blanks.includes(index);
                    return (
                      <div key={index} className={`answer-card ${needsReview ? "warn" : ""}`}>
                        <span>Q{index + 1}</span>
                        <select
                          value={answer}
                          onChange={(event) =>
                            updatePendingAnswer(index, event.target.value as AlternativeLabel)
                          }
                        >
                          {alternativeLabels
                            .slice(0, pendingScan.template.alternativesCount)
                            .map((label) => (
                              <option key={label} value={label}>
                                {label}
                              </option>
                            ))}
                        </select>
                      </div>
                    );
                  })}
                </div>
                <div className="capture-toolbar">
                  <button className="secondary" onClick={() => setPendingScan(null)}>
                    Descartar leitura
                  </button>
                  <button
                    className="primary"
                    disabled={!selectedStudentId}
                    onClick={() => void safely(confirmPendingScan)}
                  >
                    Confirmar leitura
                  </button>
                </div>
              </>
            ) : (
              <div className="empty-state">
                <p>1. Escolha um lote com modelo PROEA.</p>
                <p>2. Fotografe apenas o campo do gabarito.</p>
                <p>3. Ajuste o recorte tocando na imagem.</p>
                <p>4. Analise e confirme o aluno.</p>
              </div>
            )}
          </Card>
        </section>
      ) : null}

      {activeView === "modelos" ? (
        <section className="grid single">
          <Card
            title="Modelos calibrados"
            description="Cadastre a geometria base dos gabaritos existentes. Os presets PROEA ja vem prontos."
          >
            <div className="form-grid">
              <label>
                Nome do modelo
                <input
                  value={templateDraft.name}
                  onChange={(event) =>
                    setTemplateDraft((current) => ({ ...current, name: event.target.value }))
                  }
                  placeholder="Ex.: SAEB 5o ano"
                />
              </label>
              <label>
                Questoes
                <input
                  type="number"
                  min={1}
                  max={120}
                  value={templateDraft.questionCount}
                  onChange={(event) =>
                    setTemplateDraft((current) => ({
                      ...current,
                      questionCount: Number(event.target.value)
                    }))
                  }
                />
              </label>
              <label>
                Alternativas
                <input
                  type="number"
                  min={2}
                  max={6}
                  value={templateDraft.alternativesCount}
                  onChange={(event) =>
                    setTemplateDraft((current) => ({
                      ...current,
                      alternativesCount: Number(event.target.value)
                    }))
                  }
                />
              </label>
              <label>
                Colunas de questoes
                <input
                  type="number"
                  min={1}
                  max={6}
                  value={templateDraft.columnCount}
                  onChange={(event) =>
                    setTemplateDraft((current) => ({
                      ...current,
                      columnCount: Number(event.target.value)
                    }))
                  }
                />
              </label>
            </div>

            <div className="slider-grid">
              <SliderField
                label="Inicio X da regiao"
                value={templateDraft.regionX}
                min={0}
                max={0.9}
                step={0.01}
                onChange={(value) =>
                  setTemplateDraft((current) => ({ ...current, regionX: Number(value) }))
                }
              />
              <SliderField
                label="Inicio Y da regiao"
                value={templateDraft.regionY}
                min={0}
                max={0.9}
                step={0.01}
                onChange={(value) =>
                  setTemplateDraft((current) => ({ ...current, regionY: Number(value) }))
                }
              />
              <SliderField
                label="Largura da regiao"
                value={templateDraft.regionWidth}
                min={0.1}
                max={1}
                step={0.01}
                onChange={(value) =>
                  setTemplateDraft((current) => ({ ...current, regionWidth: Number(value) }))
                }
              />
              <SliderField
                label="Altura da regiao"
                value={templateDraft.regionHeight}
                min={0.1}
                max={1}
                step={0.01}
                onChange={(value) =>
                  setTemplateDraft((current) => ({ ...current, regionHeight: Number(value) }))
                }
              />
              <SliderField
                label="Espaco entre linhas"
                value={templateDraft.rowGapRatio}
                min={0}
                max={0.08}
                step={0.001}
                onChange={(value) =>
                  setTemplateDraft((current) => ({ ...current, rowGapRatio: Number(value) }))
                }
              />
              <SliderField
                label="Espaco entre colunas"
                value={templateDraft.columnGapRatio}
                min={0}
                max={0.12}
                step={0.001}
                onChange={(value) =>
                  setTemplateDraft((current) => ({ ...current, columnGapRatio: Number(value) }))
                }
              />
              <SliderField
                label="Limiar OpenCV"
                value={templateDraft.threshold}
                min={11}
                max={63}
                step={2}
                onChange={(value) =>
                  setTemplateDraft((current) => ({ ...current, threshold: Number(value) }))
                }
              />
              <SliderField
                label="Confianca minima"
                value={templateDraft.minConfidence}
                min={0.05}
                max={0.4}
                step={0.01}
                onChange={(value) =>
                  setTemplateDraft((current) => ({ ...current, minConfidence: Number(value) }))
                }
              />
            </div>

            <div className="template-preview">
              <div className="phone-sheet">
                <div
                  className="overlay-region"
                  style={{
                    left: `${templateDraft.regionX * 100}%`,
                    top: `${templateDraft.regionY * 100}%`,
                    width: `${templateDraft.regionWidth * 100}%`,
                    height: `${templateDraft.regionHeight * 100}%`
                  }}
                />
              </div>
            </div>

            <div className="capture-toolbar">
              <button className="primary" onClick={() => void safely(saveTemplate)}>
                Salvar modelo
              </button>
              <button className="secondary" onClick={() => void safely(seedProeaTemplates)}>
                Recarregar modelos PROEA
              </button>
            </div>

            <div className="note-block">
              <strong>Estrutura detectada no PDF PROEA</strong>
              <p>4 alternativas (`A-D`), 26 questões em Português/Matemática e 27 em Ciências.</p>
              <p>Esses modelos sao o ponto de partida da captura manual do bloco do gabarito.</p>
            </div>

            <div className="stack">
              {templates.map((template) => (
                <button
                  key={template.id}
                  className={`list-button ${activePreviewTemplateId === template.id ? "selected" : ""}`}
                  onClick={() => setActivePreviewTemplateId(template.id)}
                >
                  <strong>{template.name}</strong>
                  <span>
                    {template.questionCount} questoes, {template.alternativesCount} alternativas,{" "}
                    {template.columnCount} colunas
                  </span>
                  {template.bookletCode ? (
                    <span>
                      {template.family} • {template.bookletCode}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          </Card>
        </section>
      ) : null}

      {activeView === "lotes" ? (
        <section className="grid single">
          <Card
            title="Lotes e gabaritos"
            description="Crie a turma, informe o gabarito oficial e selecione o modelo PROEA antes da operacao."
          >
            <div className="form-grid">
              <label>
                Nome do lote
                <input
                  value={lotDraft.name}
                  onChange={(event) =>
                    setLotDraft((current) => ({ ...current, name: event.target.value }))
                  }
                  placeholder="Ex.: 5A Matematica - Maio"
                />
              </label>
              <label>
                Turma
                <input
                  value={lotDraft.className}
                  onChange={(event) =>
                    setLotDraft((current) => ({ ...current, className: event.target.value }))
                  }
                  placeholder="Ex.: 5A"
                />
              </label>
              <label>
                Modelo
                <select
                  value={lotDraft.templateId}
                  onChange={(event) =>
                    setLotDraft((current) => ({ ...current, templateId: event.target.value }))
                  }
                >
                  <option value="">Escolha um modelo</option>
                  {templates.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.name}
                      {template.bookletCode ? ` (${template.bookletCode})` : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Quantidade esperada de alunos
                <input
                  type="number"
                  min={1}
                  max={500}
                  value={lotDraft.expectedStudentCount}
                  onChange={(event) =>
                    setLotDraft((current) => ({
                      ...current,
                      expectedStudentCount: Number(event.target.value)
                    }))
                  }
                />
              </label>
            </div>

            <label>
              Gabarito oficial
              <textarea
                rows={3}
                value={lotDraft.answerKey}
                onChange={(event) =>
                  setLotDraft((current) => ({ ...current, answerKey: event.target.value }))
                }
                placeholder="Digite a sequencia de respostas, ex.: ABCDABCD..."
              />
            </label>
            <label>
              Lista de alunos
              <textarea
                rows={6}
                value={lotDraft.roster}
                onChange={(event) =>
                  setLotDraft((current) => ({ ...current, roster: event.target.value }))
                }
                placeholder="Um nome por linha. Se deixar em branco, o sistema cria Aluno 1, Aluno 2..."
              />
            </label>

            <button className="primary" onClick={() => void safely(saveLot)}>
              Criar lote
            </button>

            <div className="stack">
              {lots.map((lot) => (
                <button
                  key={lot.id}
                  className={`list-button ${selectedLotId === lot.id ? "selected" : ""}`}
                  onClick={() => {
                    setSelectedLotId(lot.id);
                    setSelectedStudentId("");
                    setCaptureDraft(null);
                    setPendingScan(null);
                  }}
                >
                  <strong>{lot.name}</strong>
                  <span>
                    {lot.className} • {lot.questionCount} questoes • {lot.expectedStudentCount} alunos
                  </span>
                </button>
              ))}
            </div>
          </Card>
        </section>
      ) : null}

      {activeView === "resultados" ? (
        <section className="grid two">
          <Card
            title="Resultados do lote"
            description="Acompanhe os percentuais por aluno e exporte o fechamento da turma em CSV."
          >
            {selectedLot ? (
              <>
                <div className="lot-summary">
                  <p>
                    <strong>{selectedLot.name}</strong> • {selectedLot.className}
                  </p>
                  <p>
                    {lotScans.length} de {selectedLot.expectedStudentCount} provas confirmadas
                  </p>
                </div>
                <div className="stack compact">
                  {lotScans.map((scan) => {
                    const student = lotStudents.find((item) => item.id === scan.studentId);
                    return (
                      <article key={scan.id} className="result-row">
                        <div>
                          <strong>{student?.name ?? "Sem aluno"}</strong>
                          <span>{formatDate(scan.createdAt)}</span>
                        </div>
                        <div>
                          <strong>{scan.percent}%</strong>
                          <span>{scan.correctCount} acertos</span>
                        </div>
                      </article>
                    );
                  })}
                </div>
                <button
                  className="primary"
                  disabled={lotScans.length === 0}
                  onClick={() => void exportLotCsv(selectedLot, lotScans, lotStudents)}
                >
                  Exportar CSV deste lote
                </button>
              </>
            ) : (
              <p className="empty-state">Selecione um lote para acompanhar o fechamento.</p>
            )}
          </Card>

          <Card
            title="Base local"
            description="Os dados ficam no navegador. Exporte backup JSON com frequencia para preservar a operacao."
          >
            <div className="stack compact">
              <button className="primary" onClick={() => void exportBackupJson()}>
                Exportar backup JSON
              </button>
              <button className="secondary" onClick={() => importInputRef.current?.click()}>
                Importar backup JSON
              </button>
              <input
                ref={importInputRef}
                hidden
                type="file"
                accept="application/json"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) {
                    void safely(() => onImportBackup(file));
                  }
                  event.target.value = "";
                }}
              />
              <p className="hint">
                Use o mesmo navegador do iPhone no dia a dia e exporte backup ao fim de cada lote.
              </p>
            </div>
          </Card>
        </section>
      ) : null}
    </main>
  );
}

function CropEditor({
  imageUrl,
  crop,
  suggestedCrop,
  onChange
}: {
  imageUrl: string;
  crop: CropRect;
  suggestedCrop: CropRect;
  onChange: (nextCrop: CropRect) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const interactionRef = useRef<{
    mode: DragMode;
    startX: number;
    startY: number;
    initialCrop: CropRect;
  } | null>(null);

  useEffect(() => {
    function handlePointerMove(event: PointerEvent) {
      const host = hostRef.current;
      const interaction = interactionRef.current;
      if (!host || !interaction) {
        return;
      }
      const rect = host.getBoundingClientRect();
      const dx = (event.clientX - interaction.startX) / rect.width;
      const dy = (event.clientY - interaction.startY) / rect.height;
      const initial = interaction.initialCrop;
      let next = initial;

      switch (interaction.mode) {
        case "move":
          next = {
            ...initial,
            x: initial.x + dx,
            y: initial.y + dy
          };
          break;
        case "se":
          next = {
            ...initial,
            width: initial.width + dx,
            height: initial.height + dy
          };
          break;
        case "sw":
          next = {
            x: initial.x + dx,
            y: initial.y,
            width: initial.width - dx,
            height: initial.height + dy
          };
          break;
        case "ne":
          next = {
            x: initial.x,
            y: initial.y + dy,
            width: initial.width + dx,
            height: initial.height - dy
          };
          break;
        case "nw":
          next = {
            x: initial.x + dx,
            y: initial.y + dy,
            width: initial.width - dx,
            height: initial.height - dy
          };
          break;
      }

      onChange(clampCrop(next));
    }

    function handlePointerUp() {
      interactionRef.current = null;
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [onChange]);

  function startInteraction(event: React.PointerEvent, mode: DragMode) {
    event.preventDefault();
    interactionRef.current = {
      mode,
      startX: event.clientX,
      startY: event.clientY,
      initialCrop: crop
    };
  }

  return (
    <div className="crop-stage">
      <div className="crop-canvas" ref={hostRef}>
        <img src={imageUrl} alt="Imagem preparada para recorte do gabarito" />
        <div
          className="suggested-crop"
          style={{
            left: `${suggestedCrop.x * 100}%`,
            top: `${suggestedCrop.y * 100}%`,
            width: `${suggestedCrop.width * 100}%`,
            height: `${suggestedCrop.height * 100}%`
          }}
        />
        <div
          className="active-crop"
          style={{
            left: `${crop.x * 100}%`,
            top: `${crop.y * 100}%`,
            width: `${crop.width * 100}%`,
            height: `${crop.height * 100}%`
          }}
          onPointerDown={(event) => startInteraction(event, "move")}
        >
          <button className="crop-handle nw" onPointerDown={(event) => startInteraction(event, "nw")} />
          <button className="crop-handle ne" onPointerDown={(event) => startInteraction(event, "ne")} />
          <button className="crop-handle sw" onPointerDown={(event) => startInteraction(event, "sw")} />
          <button className="crop-handle se" onPointerDown={(event) => startInteraction(event, "se")} />
        </div>
      </div>

      <div className="crop-sliders">
        <SliderField
          label="Posicao X"
          value={crop.x}
          min={0}
          max={1 - crop.width}
          step={0.01}
          onChange={(value) => onChange({ ...crop, x: Number(value) })}
        />
        <SliderField
          label="Posicao Y"
          value={crop.y}
          min={0}
          max={1 - crop.height}
          step={0.01}
          onChange={(value) => onChange({ ...crop, y: Number(value) })}
        />
        <SliderField
          label="Largura"
          value={crop.width}
          min={MIN_CROP_SIZE}
          max={1 - crop.x}
          step={0.01}
          onChange={(value) => onChange({ ...crop, width: Number(value) })}
        />
        <SliderField
          label="Altura"
          value={crop.height}
          min={MIN_CROP_SIZE}
          max={1 - crop.y}
          step={0.01}
          onChange={(value) => onChange({ ...crop, height: Number(value) })}
        />
      </div>
    </div>
  );
}

function Card({
  title,
  description,
  children
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="card">
      <div className="card-head">
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      {children}
    </section>
  );
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <article className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function SliderField({
  label,
  value,
  min,
  max,
  step,
  onChange
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: string) => void;
}) {
  return (
    <label className="slider-field">
      <span>
        {label}: <strong>{value.toFixed(step < 1 ? 3 : 0)}</strong>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}
