import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import OpenAI from "openai";
import sharp from "sharp";

export type ProductImage = {
  id?: string | null;
  url?: string | null;
  src?: string | null;
  altText?: string | null;
};

export type ProductForOptimization = {
  id: string;
  title: string;
  description?: string;
  descriptionHtml?: string;
  supplierDescriptionText?: string;
  productType?: string;
  tags?: string[];
  options?: unknown[];
  variants?: unknown[];
  images?: ProductImage[];
  existingMetafields?: Record<string, unknown>;
};

export type GeneratedContent = {
  productDescriptionHtml: string;
  description: string;
  keyFeatures: string;
  whatsInTheBox: string;
  compatibility: string;
  faqs: string;
  seoTitle: string;
  seoDescription: string;
  productType: string;
  tags: string;
  verification: {
    confidence: "high" | "medium" | "low";
    verifiedFactsUsed: string[];
    unsafeClaimsAvoided: string[];
    merchantReviewNeeded: boolean;
  };
};

type TrustedSpecSource = {
  url: string;
  ok: boolean;
  error?: string;
  contentType?: string;
  text?: string;
};

const OUTPUT_DIR = path.join(process.cwd(), "public", "optimized-images");
const OPENAI_TEXT_MODEL = process.env.OPENAI_TEXT_MODEL || "gpt-5.1-mini";
const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1";
const OPENAI_IMAGE_SIZE = process.env.OPENAI_IMAGE_SIZE || "1024x1024";
const MAX_IMAGE_BYTES = Number(process.env.MAX_IMAGE_BYTES || 25_000_000);
const DOWNLOAD_TIMEOUT_MS = Number(process.env.DOWNLOAD_TIMEOUT_MS || 15_000);
const MAX_SPEC_SOURCE_BYTES = Number(process.env.MAX_SPEC_SOURCE_BYTES || 1_000_000);
const SPEC_SOURCE_TIMEOUT_MS = Number(process.env.SPEC_SOURCE_TIMEOUT_MS || 10_000);

const allowedImageHosts = splitEnv(
  process.env.IMAGE_ALLOWED_HOSTS ||
    "cdn.shopify.com,cdn.shopifycdn.net,cdn.shopifycloud.com",
);
const allowedSpecHosts = splitEnv(process.env.SPEC_ALLOWED_HOSTS || "");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

function splitEnv(value = "") {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function randomId() {
  return crypto.randomBytes(12).toString("hex");
}

export function stripHtml(html = "") {
  return String(html).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function truncateText(text: unknown, maxLength: number) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function ensureOutputDir() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
}

function ensureAllowedUrl(sourceUrl: string, allowedHosts: string[], label: string) {
  let parsed: URL;

  try {
    parsed = new URL(sourceUrl);
  } catch {
    throw new Error(`Invalid ${label} URL.`);
  }

  if (!["https:", "http:"].includes(parsed.protocol)) {
    throw new Error(`${label} URL must use http or https.`);
  }

  if (allowedHosts.length === 0) {
    throw new Error(`No ${label} hosts configured.`);
  }

  const hostname = parsed.hostname.toLowerCase();
  const allowed = allowedHosts.some((host) => {
    const normalized = host.toLowerCase();
    return hostname === normalized || hostname.endsWith(`.${normalized}`);
  });

  if (!allowed) {
    throw new Error(`${label} host is not allowed: ${hostname}`);
  }

  return parsed.toString();
}

function cleanupFiles(paths: Array<string | null | undefined>) {
  for (const filePath of paths) {
    if (!filePath) continue;
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {
      // Best-effort cleanup only.
    }
  }
}

function buildProductFacts(product: ProductForOptimization) {
  return [
    `Title: ${product.title || ""}`,
    `Product type: ${product.productType || ""}`,
    `Tags: ${(product.tags || []).join(", ")}`,
    `Description: ${truncateText(product.description || stripHtml(product.descriptionHtml || ""), 1500)}`,
    `Supplier/raw import description: ${truncateText(product.supplierDescriptionText || stripHtml(product.descriptionHtml || ""), 5000)}`,
    `Options: ${truncateText(JSON.stringify(product.options || []), 2000)}`,
    `Variants: ${truncateText(JSON.stringify(product.variants || []), 3000)}`,
    `Existing metafields: ${truncateText(JSON.stringify(product.existingMetafields || {}), 3000)}`,
  ].join("\n");
}

function extractSpecText(rawText: string, contentType: string) {
  if (contentType.includes("text/html")) {
    return truncateText(
      rawText
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&"),
      8000,
    );
  }

  return truncateText(rawText, 8000);
}

export async function fetchTrustedSpecSources(sourceUrls: string[]) {
  const sources: TrustedSpecSource[] = [];

  for (const sourceUrl of sourceUrls.slice(0, 5)) {
    try {
      const safeUrl = ensureAllowedUrl(
        sourceUrl,
        allowedSpecHosts,
        "trusted spec source",
      );
      const response = await fetch(safeUrl, {
        signal: AbortSignal.timeout(SPEC_SOURCE_TIMEOUT_MS),
        redirect: "follow",
      });

      if (!response.ok) {
        sources.push({
          url: sourceUrl,
          ok: false,
          error: `${response.status} ${response.statusText}`,
        });
        continue;
      }

      const contentType = response.headers.get("content-type") || "";
      if (
        !contentType.includes("text/") &&
        !contentType.includes("json") &&
        !contentType.includes("xml")
      ) {
        sources.push({
          url: sourceUrl,
          ok: false,
          error: `Unsupported content type: ${contentType || "unknown"}`,
        });
        continue;
      }

      const contentLength = Number(response.headers.get("content-length") || 0);
      if (contentLength > MAX_SPEC_SOURCE_BYTES) {
        sources.push({
          url: sourceUrl,
          ok: false,
          error: `Source too large. Max ${MAX_SPEC_SOURCE_BYTES} bytes.`,
        });
        continue;
      }

      const text = await response.text();
      sources.push({
        url: safeUrl,
        ok: true,
        contentType,
        text: extractSpecText(text, contentType),
      });
    } catch (error) {
      sources.push({
        url: sourceUrl,
        ok: false,
        error: error instanceof Error ? error.message : "Failed to fetch source.",
      });
    }
  }

  return sources;
}

const productContentJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "productDescriptionHtml",
    "description",
    "keyFeatures",
    "whatsInTheBox",
    "compatibility",
    "faqs",
    "seoTitle",
    "seoDescription",
    "productType",
    "tags",
    "verification",
  ],
  properties: {
    productDescriptionHtml: { type: "string" },
    description: { type: "string" },
    keyFeatures: { type: "string" },
    whatsInTheBox: { type: "string" },
    compatibility: { type: "string" },
    faqs: { type: "string" },
    seoTitle: { type: "string" },
    seoDescription: { type: "string" },
    productType: { type: "string" },
    tags: { type: "string" },
    verification: {
      type: "object",
      additionalProperties: false,
      required: [
        "confidence",
        "verifiedFactsUsed",
        "unsafeClaimsAvoided",
        "merchantReviewNeeded",
      ],
      properties: {
        confidence: { type: "string", enum: ["high", "medium", "low"] },
        verifiedFactsUsed: { type: "array", items: { type: "string" } },
        unsafeClaimsAvoided: { type: "array", items: { type: "string" } },
        merchantReviewNeeded: { type: "boolean" },
      },
    },
  },
};

function buildContentPrompt(
  product: ProductForOptimization,
  trustedSpecSources: TrustedSpecSource[],
) {
  const successfulSources = trustedSpecSources.filter((source) => source.ok);
  const failedSources = trustedSpecSources.filter((source) => !source.ok);

  return `
You are an expert ecommerce copywriter for a premium Shopify electronics/accessories store called Rezar.

Generate accurate, high-converting product content.

Rules:
- Do not invent exact specs.
- Do not invent wattage, mAh capacity, materials, charging speed, waterproof rating, or exact model compatibility unless clearly provided.
- Treat Shopify product data, supplier/raw import description, and fetched trusted spec sources as the only evidence.
- Supplier/raw import description may contain useful specs from AliExpress or another supplier.
- Use supplier/raw import description as evidence only when it clearly states the fact.
- Never copy supplier wording directly.
- Never mention AliExpress, supplier, factory, wholesale, marketplace, or dropshipping in customer-facing output.
- If exact information is missing, use safe wording like "compatible devices", "supported models", or "check your device specifications".
- keyFeatures, whatsInTheBox, and compatibility must be newline-separated bullet lists using "- ".
- faqs must be numbered questions and answers separated by blank lines.
- seoTitle must be under 70 characters.
- seoDescription must be under 160 characters.
- verification.verifiedFactsUsed must list only facts clearly present in supplied data.
- verification.unsafeClaimsAvoided must list claims you intentionally avoided because they were not verified.
- verification.merchantReviewNeeded must be true when exact specs, included accessories, or compatibility are unclear.

Verified Shopify product data:
${buildProductFacts(product)}

Trusted spec sources fetched successfully:
${
  successfulSources.length > 0
    ? successfulSources
        .map((source) => `Source: ${source.url}\n${source.text}`)
        .join("\n\n")
    : "None provided or none could be fetched."
}

Trusted spec sources that could not be used:
${
  failedSources.length > 0
    ? failedSources
        .map((source) => `${source.url}: ${source.error || "Failed"}`)
        .join("\n")
    : "None."
}
`;
}

function normalizeContent(parsed: Partial<GeneratedContent>, product: ProductForOptimization) {
  return {
    productDescriptionHtml: String(parsed.productDescriptionHtml || ""),
    description: String(parsed.description || ""),
    keyFeatures: String(parsed.keyFeatures || ""),
    whatsInTheBox: String(parsed.whatsInTheBox || ""),
    compatibility: String(parsed.compatibility || ""),
    faqs: String(parsed.faqs || ""),
    seoTitle: String(parsed.seoTitle || `${product.title || "Product"} | Rezar`).slice(0, 70),
    seoDescription: String(parsed.seoDescription || "").slice(0, 160),
    productType: String(parsed.productType || product.productType || ""),
    tags: String(parsed.tags || (product.tags || []).join(", ")),
    verification: {
      confidence: parsed.verification?.confidence || "low",
      verifiedFactsUsed: Array.isArray(parsed.verification?.verifiedFactsUsed)
        ? parsed.verification.verifiedFactsUsed
        : [],
      unsafeClaimsAvoided: Array.isArray(parsed.verification?.unsafeClaimsAvoided)
        ? parsed.verification.unsafeClaimsAvoided
        : [],
      merchantReviewNeeded: Boolean(parsed.verification?.merchantReviewNeeded),
    },
  } satisfies GeneratedContent;
}

export async function generateProductContent(
  product: ProductForOptimization,
  trustedSpecSources: TrustedSpecSource[],
) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured.");
  }

  const response = await openai.responses.create({
    model: OPENAI_TEXT_MODEL,
    input: buildContentPrompt(product, trustedSpecSources),
    text: {
      format: {
        type: "json_schema",
        name: "product_content",
        strict: true,
        schema: productContentJsonSchema,
      },
    },
  });

  if (!response.output_text) {
    throw new Error("OpenAI returned no text output.");
  }

  return normalizeContent(JSON.parse(response.output_text), product);
}

async function downloadImageToTemp(imageUrl: string) {
  const safeUrl = ensureAllowedUrl(imageUrl, allowedImageHosts, "image");
  const response = await fetch(safeUrl, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`Failed to download image: ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.startsWith("image/")) {
    throw new Error(`URL did not return an image. Content-Type: ${contentType || "unknown"}`);
  }

  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > MAX_IMAGE_BYTES) {
    throw new Error(`Image is too large. Max allowed is ${MAX_IMAGE_BYTES} bytes.`);
  }

  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`Image is too large. Max allowed is ${MAX_IMAGE_BYTES} bytes.`);
  }

  const ext = contentType.includes("png")
    ? "png"
    : contentType.includes("webp")
      ? "webp"
      : contentType.includes("jpeg") || contentType.includes("jpg")
        ? "jpg"
        : "png";

  const tempPath = path.join(os.tmpdir(), `${randomId()}.${ext}`);
  fs.writeFileSync(tempPath, Buffer.from(arrayBuffer));
  return tempPath;
}

async function editImageWithOpenAI(inputPath: string, productTitle: string) {
  const imageResult = await openai.images.edit({
    model: OPENAI_IMAGE_MODEL,
    image: fs.createReadStream(inputPath),
    prompt: `
Edit this ecommerce product image for a premium Shopify product page.

Remove supplier text, background text, labels, numbers, promotional graphics, watermarks, and distracting objects.
Keep the actual product shape, color, ports, buttons, screen, proportions, and physical design unchanged.
Do not invent new features or fake branding.
Clean the background into a minimal premium studio background.
Slightly improve clarity, sharpness, lighting, and material detail.
Keep the product centered and fully visible.
Output square 1:1.

Product title:
${productTitle || ""}
`,
    size: OPENAI_IMAGE_SIZE,
  });

  const b64 = imageResult?.data?.[0]?.b64_json;
  if (!b64) throw new Error("OpenAI image edit returned no image.");

  const aiEditedPath = path.join(os.tmpdir(), `${randomId()}-ai.png`);
  fs.writeFileSync(aiEditedPath, Buffer.from(b64, "base64"));
  return aiEditedPath;
}

async function makeSquare3500(inputPath: string, publicBaseUrl: string) {
  ensureOutputDir();

  const outputName = `${randomId()}-3500.webp`;
  const outputPath = path.join(OUTPUT_DIR, outputName);
  const metadata = await sharp(inputPath, { failOn: "none" }).metadata();
  const sourceSquareSize = Math.max(metadata.width || 1000, metadata.height || 1000);

  await sharp(inputPath, { failOn: "none" })
    .resize({
      width: sourceSquareSize,
      height: sourceSquareSize,
      fit: "contain",
      background: { r: 245, g: 245, b: 245, alpha: 1 },
    })
    .resize({
      width: 3500,
      height: 3500,
      fit: "contain",
      background: { r: 245, g: 245, b: 245, alpha: 1 },
    })
    .sharpen({ sigma: 1.1, m1: 0.8, m2: 1.2 })
    .modulate({ brightness: 1.02, saturation: 1.03 })
    .webp({ quality: 92 })
    .toFile(outputPath);

  return {
    filePath: outputPath,
    url: `${publicBaseUrl.replace(/\/$/, "")}/optimized-images/${outputName}`,
  };
}

export async function optimizeOneImage({
  imageUrl,
  productTitle,
  publicBaseUrl,
  applyAiEdit,
}: {
  imageUrl: string;
  productTitle: string;
  publicBaseUrl: string;
  applyAiEdit: boolean;
}) {
  const tempFiles: string[] = [];

  try {
    const originalPath = await downloadImageToTemp(imageUrl);
    tempFiles.push(originalPath);

    let finalInputPath = originalPath;
    let aiEditUsed = false;
    let note = "";

    if (applyAiEdit) {
      try {
        const aiPath = await editImageWithOpenAI(originalPath, productTitle);
        tempFiles.push(aiPath);
        finalInputPath = aiPath;
        aiEditUsed = true;
        note = "OpenAI image edit applied.";
      } catch (error) {
        console.error("OpenAI image edit failed, using Sharp fallback:", error);
        note = `OpenAI image edit failed. Used Sharp enhancement only. ${
          error instanceof Error ? error.message : ""
        }`;
      }
    }

    const optimized = await makeSquare3500(finalInputPath, publicBaseUrl);

    return {
      optimizedImageUrl: optimized.url,
      optimizedImagePath: optimized.filePath,
      outputSize: "3500x3500",
      format: "webp",
      aiEditUsed,
      note: note || "Image optimized successfully.",
    };
  } finally {
    cleanupFiles(tempFiles);
  }
}
