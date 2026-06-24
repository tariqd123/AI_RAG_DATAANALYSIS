import { generateText, Output } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { createLogger } from "@/lib/logger";
import type {
  CellValue,
  ScreenshotExtraction,
  ScreenshotImageExtraction,
  WorkbookData,
} from "@/lib/types";

const log = createLogger("ocr/extract");

export const EXTRACT_MODEL = "claude-sonnet-4-6";

/** An uploaded screenshot image (raw bytes + media type). */
export interface ScreenshotImage {
  name: string;
  bytes: Uint8Array;
  mediaType: string;
}

// Schema for what Claude returns: tables modelled as columns + string-cell rows
// (robust to messy data), plus per-image chart/KPI metadata and limitations.
// `imageName` ties each per-image entry back to the uploaded file so we can
// report it accurately even when several images are sent at once.
const extractionSchema = z.object({
  tables: z
    .array(
      z.object({
        name: z.string().describe("Short, unique, snake_case-ish table name."),
        sourceImage: z
          .string()
          .describe("The image/file name this table was read from.")
          .optional(),
        columns: z.array(z.string()).describe("Column headers in order."),
        rows: z
          .array(z.array(z.string()))
          .describe("Each row is an array of cell strings aligned to columns."),
      }),
    )
    .describe("All tabular data found across the screenshots."),
  perImage: z
    .array(
      z.object({
        name: z.string().describe("The image/file name this refers to (match the provided names exactly)."),
        summary: z.string().describe("1-2 sentences: what this screenshot shows."),
        confidence: z
          .number()
          .min(0)
          .max(100)
          .describe("Your confidence 0-100 that the values you read are correct (image clarity, legibility)."),
        charts: z.array(
          z.object({
            title: z.string(),
            chartType: z.string().describe("bar | line | pie | table | kpi | unknown"),
            xAxis: z.string().optional(),
            yAxis: z.string().optional(),
            legend: z.array(z.string()),
            series: z.array(z.string()),
            dataLabels: z.array(z.string()).describe("Numeric values you can read from the chart (printed labels or clearly estimable from the axis)."),
            notes: z.string().optional(),
          }),
        ),
        kpis: z.array(
          z.object({
            label: z.string(),
            value: z.string(),
            change: z.string().optional(),
          }),
        ),
      }),
    )
    .describe("One entry per uploaded screenshot."),
  limitations: z
    .string()
    .describe("Caveats: blurry/low-resolution regions, charts without numeric labels, ambiguous values, etc."),
});

type RawExtraction = z.infer<typeof extractionSchema>;

/**
 * Turn one or more screenshot images into a structured dataset using Claude
 * vision. Claude reads the images directly (no separate OCR step), which is
 * fast and reliable on serverless and can also read chart values. Numbers are
 * NOT computed here — this only structures what is visible in the images.
 */
export async function extractStructuredData(images: ScreenshotImage[]): Promise<ScreenshotExtraction> {
  const nameList = images.map((i, idx) => `${idx + 1}. ${i.name} (${i.mediaType})`).join("\n");

  const instructions = `You are a data-extraction engine. You are given one or more screenshots of data (Excel, dashboards, Power BI/Tableau, reports, tables, charts, KPI cards, web apps, PDFs rendered as images).

Read every image carefully and reconstruct its structured content as faithfully as possible:
- Identify every table: its columns and rows. Align cells to columns. Read numbers exactly as shown (do not compute or invent values). Set each table's "sourceImage" to the file it came from.
- Capture charts: title, type, axis labels, legend, series names, and the numeric data values you can read (use printed data labels; if unlabelled but clearly readable from the axis gridlines, give your best read and note it).
- Capture standalone KPIs / metric cards (label + value + any change text).
- For each image, give a confidence 0-100 reflecting how legible it was.
- Note limitations: blurry regions, charts whose values cannot be read, or anything ambiguous.

Do not fabricate data. If something is unreadable, omit it and mention it in limitations.

The uploaded images, in order, are:
${nameList}`;

  const started = Date.now();
  const { output } = await generateText({
    model: anthropic(EXTRACT_MODEL),
    output: Output.object({ schema: extractionSchema }),
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: instructions },
          ...images.map((img) => ({
            type: "image" as const,
            image: img.bytes,
            mediaType: img.mediaType,
          })),
        ],
      },
    ],
  });
  const raw = output as RawExtraction;

  const tables = toWorkbookData(raw.tables);

  // Map model output back to per-image entries. Prefer the model's reported
  // name; fall back to positional matching so every uploaded image is covered.
  const perImage: ScreenshotImageExtraction[] = images.map((img, idx) => {
    const match =
      raw.perImage.find((p) => p.name === img.name) ?? raw.perImage[idx];
    return {
      name: img.name,
      summary: match?.summary ?? "No description available.",
      // `ocrConfidence` field name kept for UI/storage compatibility; now this
      // is the vision model's self-reported legibility confidence.
      ocrConfidence: Math.round(match?.confidence ?? 0),
      charts: (match?.charts ?? []).map((c) => ({
        title: c.title,
        chartType: c.chartType,
        xAxis: c.xAxis,
        yAxis: c.yAxis,
        legend: c.legend ?? [],
        series: c.series ?? [],
        dataLabels: c.dataLabels ?? [],
        notes: c.notes,
      })),
      kpis: match?.kpis ?? [],
    };
  });

  log.info("Extraction complete", {
    tables: Object.keys(tables).length,
    images: perImage.length,
    elapsedMs: Date.now() - started,
  });

  return { perImage, tables, limitations: raw.limitations };
}

/** Convert Claude's columns+rows tables into WorkbookData (row objects). */
function toWorkbookData(tables: RawExtraction["tables"]): WorkbookData {
  const out: WorkbookData = {};
  const used = new Set<string>();

  for (const table of tables) {
    if (!table.columns?.length || !table.rows?.length) continue;
    const base = table.name?.trim() || "table";
    // Ensure unique sheet names.
    let n = base;
    let i = 2;
    while (used.has(n)) n = `${base}_${i++}`;
    used.add(n);

    out[n] = table.rows.map((row) => {
      const obj: Record<string, CellValue> = {};
      table.columns.forEach((col, idx) => {
        obj[col] = coerce(row[idx]);
      });
      return obj;
    });
  }
  return out;
}

/** Coerce a cell string into number where it cleanly parses, else string. */
function coerce(value: string | undefined): CellValue {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (s === "") return null;
  const cleaned = s.replace(/[$,%\s]/g, "");
  if (cleaned !== "" && !Number.isNaN(Number(cleaned)) && /^-?\d*\.?\d+$/.test(cleaned)) {
    return Number(cleaned);
  }
  return s;
}
