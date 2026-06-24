import { NextResponse } from "next/server";
import { extractStructuredData, type ScreenshotImage } from "@/lib/ocr/extract";
import { profileWorkbook } from "@/lib/excel/profile";
import { saveDataset } from "@/lib/store/datasets";
import { createLogger } from "@/lib/logger";

export const runtime = "nodejs";
export const maxDuration = 120;

const log = createLogger("api/screenshot");

const MAX_FILES = 6;
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB each
const ALLOWED_EXT = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"];

// Map an uploaded file to the media type Claude's vision API expects. Anthropic
// supports png/jpeg/webp/gif; bmp is converted by falling back to png labelling
// only if the browser already provided a supported type.
function mediaTypeFor(file: File): string {
  const t = (file.type || "").toLowerCase();
  if (["image/png", "image/jpeg", "image/webp", "image/gif"].includes(t)) return t;
  const name = file.name.toLowerCase();
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".webp")) return "image/webp";
  if (name.endsWith(".gif")) return "image/gif";
  return "image/png";
}

export async function POST(req: Request): Promise<Response> {
  if (!process.env.ANTHROPIC_API_KEY) {
    log.error("Missing ANTHROPIC_API_KEY");
    return NextResponse.json(
      { error: "Server is missing ANTHROPIC_API_KEY. Add it to .env.local and restart." },
      { status: 500 },
    );
  }

  const formData = await req.formData().catch(() => null);
  const files = formData?.getAll("file").filter((f): f is File => f instanceof File) ?? [];

  if (files.length === 0) {
    log.warn("No files uploaded");
    return NextResponse.json({ error: "Upload at least one screenshot." }, { status: 400 });
  }
  if (files.length > MAX_FILES) {
    return NextResponse.json({ error: `Too many files (max ${MAX_FILES}).` }, { status: 413 });
  }
  for (const file of files) {
    if (file.size === 0) {
      return NextResponse.json({ error: `"${file.name}" is empty.` }, { status: 400 });
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json({ error: `"${file.name}" is too large (max 10 MB).` }, { status: 413 });
    }
    if (!ALLOWED_EXT.some((ext) => file.name.toLowerCase().endsWith(ext))) {
      return NextResponse.json(
        { error: `"${file.name}" is not a supported image type.` },
        { status: 415 },
      );
    }
  }

  log.info("Screenshot upload received", { count: files.length, names: files.map((f) => f.name) });

  try {
    const images: ScreenshotImage[] = await Promise.all(
      files.map(async (f) => ({
        name: f.name,
        bytes: new Uint8Array(await f.arrayBuffer()),
        mediaType: mediaTypeFor(f),
      })),
    );

    // Structure the screenshots into a dataset using Claude vision. Claude
    // reads the images directly (no separate OCR step), which is fast and
    // reliable on serverless and avoids the WASM-OCR timeouts that caused 504s.
    const extraction = await extractStructuredData(images);

    const hasTables = Object.keys(extraction.tables).length > 0;
    const hasContent =
      hasTables ||
      extraction.perImage.some((i) => i.charts.length > 0 || i.kpis.length > 0);
    if (!hasContent) {
      log.warn("No structured content extracted from screenshots");
      return NextResponse.json(
        {
          error:
            "Could not read any tables, charts, or KPIs from these screenshots. Try a sharper, higher-resolution image.",
        },
        { status: 422 },
      );
    }

    // 3) Profile the extracted tables into a data dictionary.
    const fileName =
      files.length === 1 ? files[0].name : `${files.length} screenshots`;
    const dictionary = profileWorkbook(fileName, extraction.tables);

    // 4) Store as a screenshot-sourced dataset.
    const dataset = saveDataset(fileName, extraction.tables, dictionary, {
      source: "screenshot",
      extraction,
    });

    log.info("Screenshot dataset stored", {
      datasetId: dataset.id,
      tables: Object.keys(extraction.tables).length,
      images: extraction.perImage.length,
    });

    return NextResponse.json({
      datasetId: dataset.id,
      dictionary,
      extraction,
      dataset: {
        id: dataset.id,
        fileName: dataset.fileName,
        data: dataset.data,
        dictionary: dataset.dictionary,
        source: dataset.source,
        extraction: dataset.extraction,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to process screenshots.";
    log.error("Processing failed", { error: message });
    return NextResponse.json({ error: `Could not process screenshots: ${message}` }, { status: 500 });
  }
}
