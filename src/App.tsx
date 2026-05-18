import { useEffect, useMemo, useRef, useState } from "react";
import { db } from "./lib/db";
import { exportBackupJson, exportLotCsv, importBackupJson } from "./lib/export";
import {
  canvasToDataUrl,
  captureVideoFrame,
  createId,
  drawImageToCanvas,
  fileToDataUrl,
  getImageData
} from "./lib/image";
import { normalizeCanvasWithOpenCv } from "./lib/opencv";
import { detectBookletCodeFromCanvas } from "./lib/ocr";
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
  region: {
    x: 0.2,
    y: 0.18,
    width: 0.62,
    height: 0.68
  },
  threshold: 31,
  minConfidence: 0.11
}));

const defaultLotDraft: LotDraft = {
  name: "",
  className: "",
  templateId: "",
  expectedStudentCount: 30,
  answerKey: "",
  roster: ""
};

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
  const [cameraState, setCameraState] = useState<"idle" | "live" | "error">("idle");
  const [cameraError, setCameraError] = useState("");
  const [captureMessage, setCaptureMessage] = useState(
    "Cadastre ou escolha um lote, abra a camera e fotografe um gabarito por vez."
  );
  const [selectedStudentId, setSelectedStudentId] = useState("");
  const [activePreviewTemplateId, setActivePreviewTemplateId] = useState("");
  const selectedLotId = useAppStore((state) => state.selectedLotId);
  const pendingScan = useAppStore((state) => state.pendingScan);
  const setSelectedLotId = useAppStore((state) => state.setSelectedLotId);
  const setPendingScan = useAppStore((state) => state.setPendingScan);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);

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
  const selectedStudentScanIds = useMemo(() => new Set(lotScans.map((item) => item.studentId)), [lotScans]);

  useEffect(() => {
    async function loadAll() {
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
      if (!selectedLotId && nextLots[0]) {
        setSelectedLotId(nextLots[0].id);
      }
      setLoading(false);
    }
    void loadAll();
  }, [selectedLotId, setSelectedLotId]);

  useEffect(() => {
    return () => {
      void stopCamera();
    };
  }, []);

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

  async function stopCamera() {
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop();
      }
      streamRef.current = null;
    }
    setCameraState("idle");
  }

  async function startCamera() {
    setCameraError("");
    setCaptureMessage("Solicitando acesso a camera traseira do iPhone...");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        },
        audio: false
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCameraState("live");
      setCaptureMessage("Camera pronta. Enquadre a folha dentro da area e capture.");
    } catch (error) {
      setCameraState("error");
      setCameraError("Nao foi possivel abrir a camera. Use a galeria como plano B.");
      setCaptureMessage("Camera indisponivel. Tente enviar uma foto existente.");
      console.error(error);
    }
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
    const now = new Date().toISOString();
    const rows: TemplateModel[] = proeaTemplatePresets.map((preset) => ({
      ...preset,
      createdAt: now
    }));
    await db.templates.bulkPut(rows);
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
    setNotice("Lote criado e pronto para receber leituras.");
    await refreshAll();
  }

  async function analyzeImage(dataUrl: string) {
    if (!selectedLot) {
      throw new Error("Escolha um lote ativo antes de capturar.");
    }

    setBusyMessage("Preparando imagem e aplicando normalizacao...");
    const canvas = await drawImageToCanvas(dataUrl);
    let templateForAnalysis = selectedTemplate;

    setBusyMessage("Identificando o codigo do caderno...");
    const bookletDetection = await detectBookletCodeFromCanvas(canvas);
    if (bookletDetection.code) {
      const matchedTemplate = templates.find(
        (template) => template.bookletCode === bookletDetection.code
      );
      if (matchedTemplate) {
        templateForAnalysis = matchedTemplate;
        setNotice(`Codigo do caderno detectado: ${bookletDetection.code}. Modelo escolhido automaticamente.`);
      }
    }

    if (!templateForAnalysis) {
      throw new Error("Nao foi possivel definir o modelo de leitura para este lote.");
    }

    const normalizedCanvas = await normalizeCanvasWithOpenCv(canvas, templateForAnalysis);
    const imageData = getImageData(normalizedCanvas);
    const worker = await getScanWorker();
    setBusyMessage("Lendo regioes de resposta do modelo calibrado...");
    const analysis = await worker.analyze({
      pixels: imageData.data,
      width: imageData.width,
      height: imageData.height,
      template: templateForAnalysis
    });
    const score = scoreAnswers(analysis.detectedAnswers, selectedLot.answerKey);
    const nextPending: PendingScan = {
      lot: selectedLot,
      template: templateForAnalysis,
      detectedBookletCode: bookletDetection.code ?? undefined,
      imageUrl: dataUrl,
      normalizedImage: canvasToDataUrl(normalizedCanvas),
      detectedAnswers: analysis.detectedAnswers,
      finalAnswers: [...analysis.detectedAnswers],
      ambiguousQuestions: analysis.ambiguousQuestions,
      blanks: analysis.blanks,
      correctCount: score.correctCount,
      percent: score.percent,
      confidence: analysis.confidence
    };
    setPendingScan(nextPending);
    setBusyMessage("");
    setNotice("");
    setCaptureMessage("Leitura pronta. Revise e confirme o aluno.");
  }

  async function handleCaptureFromCamera() {
    if (!videoRef.current || cameraState !== "live") {
      return;
    }
    const frame = captureVideoFrame(videoRef.current);
    await analyzeImage(canvasToDataUrl(frame));
  }

  async function handleImageFile(file: File) {
    const dataUrl = await fileToDataUrl(file);
    await analyzeImage(dataUrl);
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
    setCaptureMessage("Leitura salva. Pode seguir para o proximo aluno.");
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
    await importBackupJson(file);
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
      console.error(error);
    }
  }

  const overview = useMemo(() => {
    const confirmed = scans.filter((scan) => scan.status === "confirmed").length;
    const average =
      scans.length === 0
        ? 0
        : Number((scans.reduce((sum, item) => sum + item.percent, 0) / scans.length).toFixed(1));
    return {
      templates: templates.length,
      lots: lots.length,
      scans: scans.length,
      confirmed,
      average
    };
  }, [lots.length, scans, templates.length]);

  if (loading) {
    return <main className="shell"><section className="hero"><h1>SCANPRO</h1><p>Carregando base local...</p></section></main>;
  }

  return (
    <main className="shell">
      <section className="hero">
        <div>
          <p className="eyebrow">iPhone-first OMR</p>
          <h1>SCANPRO</h1>
          <p className="hero-copy">
            Leitura local de gabaritos existentes com captura guiada, calibracao por modelo e
            revisao humana dos casos incertos.
          </p>
        </div>
        <div className="hero-stats">
          <MetricCard label="Modelos" value={String(overview.templates)} />
          <MetricCard label="Lotes" value={String(overview.lots)} />
          <MetricCard label="Leituras" value={String(overview.scans)} />
          <MetricCard label="Media geral" value={`${overview.average}%`} />
        </div>
      </section>

      {notice ? <div className="notice">{notice}</div> : null}

      <section className="grid two">
        <Card
          title="1. Modelo calibrado"
          description="Cadastre a geometria base dos gabaritos existentes. Ajuste a regiao onde ficam as bolhas e a quantidade de colunas."
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
            <p className="hint">
              A area destacada representa onde o sistema espera encontrar as bolhas na foto
              corrigida.
            </p>
          </div>

          <div className="capture-toolbar">
            <button className="primary" onClick={() => void safely(saveTemplate)}>
              Salvar modelo
            </button>
            <button className="secondary" onClick={() => void safely(seedProeaTemplates)}>
              Carregar modelos PROEA
            </button>
          </div>

          <div className="note-block">
            <strong>Estrutura detectada no PDF PROEA</strong>
            <p>
              Os 12 gabaritos do arquivo seguem uma família visual consistente: 4 alternativas
              (`A-D`), códigos de caderno como `P0602`, `M0702` e `N0902`, com 26 questões em
              Língua Portuguesa e Matemática e 27 questões em Ciências da Natureza.
            </p>
            <p>
              Isso permite que o app trate esses cadernos como modelos pré-calibrados, em vez de
              começar sempre do zero.
            </p>
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

        <Card
          title="2. Lote e gabarito"
          description="Crie a turma, informe o gabarito oficial e monte a lista de alunos que receberao as leituras."
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
              placeholder="Digite a sequencia de respostas, ex.: ABCDEABCDE..."
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

      <section className="grid two">
        <Card
          title="3. Captura iPhone"
          description="Use a camera traseira ou importe uma foto da galeria. O fluxo principal foi pensado para uma folha por vez."
        >
          <div className="capture-toolbar">
            <button className="primary" onClick={() => void safely(startCamera)}>
              Abrir camera
            </button>
            <button className="secondary" onClick={() => void stopCamera()}>
              Fechar camera
            </button>
            <button className="secondary" onClick={() => fileInputRef.current?.click()}>
              Enviar foto
            </button>
            <input
              ref={fileInputRef}
              hidden
              type="file"
              accept="image/*"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) {
                  void safely(() => handleImageFile(file));
                }
                event.target.value = "";
              }}
            />
          </div>

          <div className="camera-shell">
            <video ref={videoRef} autoPlay muted playsInline />
            <div className="camera-guide" />
          </div>

          <div className="capture-status">
            <p>{captureMessage}</p>
            {cameraError ? <p className="error">{cameraError}</p> : null}
            {busyMessage ? <p className="hint">{busyMessage}</p> : null}
          </div>

          <button
            className="primary large"
            disabled={cameraState !== "live" || !selectedLot}
            onClick={() => void safely(handleCaptureFromCamera)}
          >
            Capturar e ler
          </button>
        </Card>

        <Card
          title="4. Revisao e confirmacao"
          description="Os casos com baixa confianca ficam editaveis antes da gravacao final."
        >
          {pendingScan ? (
            <>
              <div className="preview-grid">
                <img src={pendingScan.imageUrl} alt="Captura original do gabarito" />
                <img src={pendingScan.normalizedImage} alt="Imagem normalizada para leitura" />
              </div>
              <div className="scan-summary">
                <MetricCard label="Acertos" value={String(pendingScan.correctCount)} />
                <MetricCard label="Percentual" value={`${pendingScan.percent}%`} />
                <MetricCard
                  label="Confianca"
                  value={`${Math.round(pendingScan.confidence * 100)}%`}
                />
                <MetricCard
                  label="Revisar"
                  value={String(
                    new Set([
                      ...pendingScan.ambiguousQuestions,
                      ...pendingScan.blanks
                    ]).size
                  )}
                />
              </div>

              <div className="note-block">
                <strong>Modelo escolhido</strong>
                <p>
                  {pendingScan.template.name}
                  {pendingScan.detectedBookletCode
                    ? ` • codigo detectado ${pendingScan.detectedBookletCode}`
                    : " • codigo do caderno nao detectado, usando modelo atual do lote"}
                </p>
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
            <p className="empty-state">
              Nenhuma folha em revisao. Capture ou envie uma foto para gerar a primeira leitura.
            </p>
          )}
        </Card>
      </section>

      <section className="grid two">
        <Card
          title="5. Resultados do lote"
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
          title="6. Base local"
          description="Os dados ficam no navegador. Exporte backup JSON com frequencia para mover ou preservar a operacao."
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
              Dica operacional: como o GitHub Pages nao oferece backend, use o mesmo navegador do
              iPhone no dia a dia e exporte backup ao fim de cada lote.
            </p>
          </div>
        </Card>
      </section>
    </main>
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
