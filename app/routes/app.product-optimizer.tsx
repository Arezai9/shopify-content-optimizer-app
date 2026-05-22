import { useEffect, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { stripHtml, type GeneratedContent } from "../models/aiProductOptimizer.server";

type ProductSearchResult = {
  id: string;
  title: string;
  featuredImage: { url: string; altText: string | null } | null;
};

type ProductDetail = {
  id: string;
  title: string;
  description: string;
  descriptionHtml: string;
  supplierDescriptionText: string;
  productType: string;
  tags: string[];
  seoTitle: string;
  seoDescription: string;
  options: Array<Record<string, unknown>>;
  variants: Array<Record<string, unknown>>;
  images: Array<{
    id: string;
    url: string;
    altText: string | null;
    width: number | null;
    height: number | null;
  }>;
  existingMetafields: Record<string, string>;
};

type ActionData =
  | { action: "search"; results: ProductSearchResult[] }
  | { action: "load"; product: ProductDetail }
  | { action: "save"; ok: boolean; userErrors?: Array<Record<string, unknown>> }
  | { action: "error"; error: string };

const SEARCH_PRODUCTS_QUERY = `#graphql
  query SearchProducts($query: String) {
    products(first: 15, query: $query) {
      nodes {
        id
        title
        featuredImage {
          url
          altText
        }
      }
    }
  }
`;

const GET_PRODUCT_DETAIL_QUERY = `#graphql
  query GetProductDetail($id: ID!) {
    product(id: $id) {
      id
      title
      description
      descriptionHtml
      productType
      tags
      seo {
        title
        description
      }
      options {
        id
        name
        position
        optionValues {
          id
          name
        }
      }
      variants(first: 100) {
        nodes {
          id
          title
          price
          selectedOptions {
            name
            value
            optionValue {
              id
            }
          }
        }
      }
      media(first: 20) {
        nodes {
          ... on MediaImage {
            id
            image {
              url
              altText
              width
              height
            }
          }
        }
      }
      descriptionMeta: metafield(namespace: "custom", key: "description") {
        jsonValue
      }
      keyFeatures: metafield(namespace: "custom", key: "key_features") {
        jsonValue
      }
      whatsInTheBox: metafield(namespace: "custom", key: "what_s_in_the_box") {
        jsonValue
      }
      compatibility: metafield(namespace: "custom", key: "compatibility") {
        jsonValue
      }
      faqs: metafield(namespace: "custom", key: "faqs") {
        jsonValue
      }
    }
  }
`;

const UPDATE_PRODUCT_MUTATION = `#graphql
  mutation UpdateProduct($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const SET_METAFIELDS_MUTATION = `#graphql
  mutation SetProductMetafields($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      userErrors {
        field
        message
        code
        elementIndex
      }
    }
  }
`;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

function buildProductSearchQuery(rawQuery: string) {
  return rawQuery
    .trim()
    .split(/\s+/)
    .map((term) => term.replace(/[^\p{L}\p{N}_-]/gu, ""))
    .filter(Boolean)
    .map((term) => `title:*${term}*`)
    .join(" ");
}

function extractTextFromRichText(jsonValue: unknown): string {
  if (!jsonValue) return "";

  try {
    const parsed = typeof jsonValue === "string" ? JSON.parse(jsonValue) : jsonValue;
    return extractTextNodes(parsed);
  } catch {
    return "";
  }
}

function extractTextNodes(node: any): string {
  if (!node) return "";
  if (node.type === "text") return node.value || "";
  if (node.type === "list-item") {
    const text = (node.children || [])
      .map(extractTextNodes)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    return `- ${text}`;
  }
  if (node.type === "list") return (node.children || []).map(extractTextNodes).join("\n");
  if (node.type === "paragraph") {
    return (node.children || [])
      .map(extractTextNodes)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }
  if (node.type === "root") return (node.children || []).map(extractTextNodes).join("\n\n");
  if (node.children) {
    return (node.children || [])
      .map(extractTextNodes)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }
  return "";
}

function textToRichTextJson(text: string, sectionType: "paragraphs" | "bullets" | "faqs") {
  const trimmed = text.trim();

  if (!trimmed) {
    return JSON.stringify({
      type: "root",
      children: [{ type: "paragraph", children: [{ type: "text", value: "" }] }],
    });
  }

  if (sectionType === "bullets") {
    return JSON.stringify({
      type: "root",
      children: [
        {
          type: "list",
          listType: "unordered",
          children: trimmed
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => ({
              type: "list-item",
              children: [{ type: "text", value: line.replace(/^[-*]\s*/, "") }],
            })),
        },
      ],
    });
  }

  const paragraphs = trimmed
    .split(sectionType === "faqs" ? "\n" : /\n\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => ({
      type: "paragraph",
      children: [{ type: "text", value: line }],
    }));

  return JSON.stringify({ type: "root", children: paragraphs });
}

function escapeHtml(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const actionType = String(formData.get("_action") || "");

  try {
    if (actionType === "search") {
      const query = buildProductSearchQuery(String(formData.get("query") || ""));
      const response = await admin.graphql(SEARCH_PRODUCTS_QUERY, {
        variables: { query },
      });
      const json = await response.json();

      return {
        action: "search",
        results: json.data?.products?.nodes || [],
      } satisfies ActionData;
    }

    if (actionType === "load") {
      const id = String(formData.get("id") || "");
      const response = await admin.graphql(GET_PRODUCT_DETAIL_QUERY, {
        variables: { id },
      });
      const json = await response.json();
      const p = json.data?.product;

      if (!p) return { action: "error", error: "Product not found." } satisfies ActionData;

      const product: ProductDetail = {
        id: p.id,
        title: p.title,
        description: p.description || "",
        descriptionHtml: p.descriptionHtml || "",
        supplierDescriptionText: stripHtml(p.descriptionHtml || p.description || ""),
        productType: p.productType || "",
        tags: p.tags || [],
        seoTitle: p.seo?.title || "",
        seoDescription: p.seo?.description || "",
        options: p.options || [],
        variants: p.variants?.nodes || [],
        images: (p.media?.nodes || [])
          .filter((node: any) => node?.image)
          .map((node: any) => ({
            id: node.id,
            url: node.image.url,
            altText: node.image.altText,
            width: node.image.width,
            height: node.image.height,
          })),
        existingMetafields: {
          description: extractTextFromRichText(p.descriptionMeta?.jsonValue),
          keyFeatures: extractTextFromRichText(p.keyFeatures?.jsonValue),
          whatsInTheBox: extractTextFromRichText(p.whatsInTheBox?.jsonValue),
          compatibility: extractTextFromRichText(p.compatibility?.jsonValue),
          faqs: extractTextFromRichText(p.faqs?.jsonValue),
        },
      };

      return { action: "load", product } satisfies ActionData;
    }

    if (actionType === "save") {
      const productId = String(formData.get("productId") || "");
      const content = JSON.parse(String(formData.get("content") || "{}")) as GeneratedContent;

      const productResponse = await admin.graphql(UPDATE_PRODUCT_MUTATION, {
        variables: {
          product: {
            id: productId,
            descriptionHtml: content.productDescriptionHtml
              ? `<p>${escapeHtml(content.productDescriptionHtml.trim())}</p>`
              : undefined,
            productType: content.productType || undefined,
            tags: content.tags
              ? content.tags
                  .split(",")
                  .map((tag) => tag.trim())
                  .filter(Boolean)
              : undefined,
            seo:
              content.seoTitle || content.seoDescription
                ? {
                    title: content.seoTitle || undefined,
                    description: content.seoDescription || undefined,
                  }
                : undefined,
          },
        },
      });
      const productJson = await productResponse.json();
      const productErrors = productJson.data?.productUpdate?.userErrors || [];

      if (productErrors.length > 0) {
        return {
          action: "save",
          ok: false,
          userErrors: productErrors,
        } satisfies ActionData;
      }

      const metafields = [
        {
          ownerId: productId,
          namespace: "custom",
          key: "description",
          type: "rich_text_field",
          value: textToRichTextJson(content.description, "paragraphs"),
        },
        {
          ownerId: productId,
          namespace: "custom",
          key: "key_features",
          type: "rich_text_field",
          value: textToRichTextJson(content.keyFeatures, "bullets"),
        },
        {
          ownerId: productId,
          namespace: "custom",
          key: "what_s_in_the_box",
          type: "rich_text_field",
          value: textToRichTextJson(content.whatsInTheBox, "bullets"),
        },
        {
          ownerId: productId,
          namespace: "custom",
          key: "compatibility",
          type: "rich_text_field",
          value: textToRichTextJson(content.compatibility, "bullets"),
        },
        {
          ownerId: productId,
          namespace: "custom",
          key: "faqs",
          type: "rich_text_field",
          value: textToRichTextJson(content.faqs, "faqs"),
        },
      ];

      const metafieldResponse = await admin.graphql(SET_METAFIELDS_MUTATION, {
        variables: { metafields },
      });
      const metafieldJson = await metafieldResponse.json();
      const metafieldErrors = metafieldJson.data?.metafieldsSet?.userErrors || [];

      return {
        action: "save",
        ok: metafieldErrors.length === 0,
        userErrors: metafieldErrors,
      } satisfies ActionData;
    }

    return { action: "error", error: "Unknown action." } satisfies ActionData;
  } catch (error) {
    return {
      action: "error",
      error: error instanceof Error ? error.message : "Request failed.",
    } satisfies ActionData;
  }
};

function emptyContent(): GeneratedContent {
  return {
    productDescriptionHtml: "",
    description: "",
    keyFeatures: "",
    whatsInTheBox: "",
    compatibility: "",
    faqs: "",
    seoTitle: "",
    seoDescription: "",
    productType: "",
    tags: "",
    verification: {
      confidence: "low",
      verifiedFactsUsed: [],
      unsafeClaimsAvoided: [],
      merchantReviewNeeded: true,
    },
  };
}

function parseTrustedSourceUrls(text: string) {
  return text
    .split(/\r?\n|,/)
    .map((url) => url.trim())
    .filter(Boolean);
}

export default function ProductOptimizer() {
  const shopify = useAppBridge();
  const searchFetcher = useFetcher<ActionData>();
  const productFetcher = useFetcher<ActionData>();
  const saveFetcher = useFetcher<ActionData>();

  const [query, setQuery] = useState("");
  const [selectedProduct, setSelectedProduct] = useState<ProductDetail | null>(null);
  const [content, setContent] = useState<GeneratedContent>(emptyContent);
  const [trustedSpecSources, setTrustedSpecSources] = useState("");
  const [optimizationResult, setOptimizationResult] = useState<any | null>(null);
  const [optimizing, setOptimizing] = useState(false);
  const [globalError, setGlobalError] = useState("");

  useEffect(() => {
    if (productFetcher.data?.action === "load") {
      setSelectedProduct(productFetcher.data.product);
      setContent({
        ...emptyContent(),
        productDescriptionHtml: productFetcher.data.product.descriptionHtml
          ? stripHtml(productFetcher.data.product.descriptionHtml)
          : "",
        description: productFetcher.data.product.existingMetafields.description || "",
        keyFeatures: productFetcher.data.product.existingMetafields.keyFeatures || "",
        whatsInTheBox: productFetcher.data.product.existingMetafields.whatsInTheBox || "",
        compatibility: productFetcher.data.product.existingMetafields.compatibility || "",
        faqs: productFetcher.data.product.existingMetafields.faqs || "",
        seoTitle: productFetcher.data.product.seoTitle,
        seoDescription: productFetcher.data.product.seoDescription,
        productType: productFetcher.data.product.productType,
        tags: productFetcher.data.product.tags.join(", "),
      });
      setOptimizationResult(null);
    }
  }, [productFetcher.data]);

  useEffect(() => {
    if (saveFetcher.data?.action === "save" && saveFetcher.data.ok) {
      shopify.toast.show("Product content saved");
    }

    if (saveFetcher.data?.action === "save" && !saveFetcher.data.ok) {
      setGlobalError(
        saveFetcher.data.userErrors
          ?.map((error) => `${error.field || ""}: ${error.message || ""}`)
          .join(", ") || "Save failed.",
      );
    }
  }, [saveFetcher.data, shopify]);

  const runSearch = () => {
    const formData = new FormData();
    formData.set("_action", "search");
    formData.set("query", query);
    searchFetcher.submit(formData, { method: "POST" });
  };

  const loadProduct = (id: string) => {
    const formData = new FormData();
    formData.set("_action", "load");
    formData.set("id", id);
    productFetcher.submit(formData, { method: "POST" });
  };

  const optimizeProduct = async () => {
    if (!selectedProduct) return;

    setOptimizing(true);
    setGlobalError("");

    try {
      const response = await fetch("/app/api/optimize-full-product", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          product: selectedProduct,
          trustedSpecSourceUrls: parseTrustedSourceUrls(trustedSpecSources),
          optimizeImages: true,
          maxImages: 1,
          applyAiImageEdit: true,
          uploadImagesToShopify: true,
        }),
      });
      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "Optimization failed.");
      }

      setContent(result.content);
      setOptimizationResult(result);
      shopify.toast.show("Product optimized");
    } catch (error) {
      setGlobalError(error instanceof Error ? error.message : "Optimization failed.");
    } finally {
      setOptimizing(false);
    }
  };

  const saveContent = () => {
    if (!selectedProduct) return;

    const formData = new FormData();
    formData.set("_action", "save");
    formData.set("productId", selectedProduct.id);
    formData.set("content", JSON.stringify(content));
    saveFetcher.submit(formData, { method: "POST" });
  };

  const searchResults =
    searchFetcher.data?.action === "search" ? searchFetcher.data.results : [];

  return (
    <s-page heading="Rezar AI Product Optimizer">
      {globalError && (
        <s-banner tone="critical" heading="Error" dismissible onDismiss={() => setGlobalError("")}>
          {globalError}
        </s-banner>
      )}

      <s-section heading="Select product">
        <s-stack gap="base">
          <s-search-field
            label="Search products"
            value={query}
            placeholder="Search by product title"
            onInput={(event: any) => setQuery(event.currentTarget.value)}
          />
          <s-button
            variant="primary"
            onClick={runSearch}
            loading={searchFetcher.state !== "idle"}
          >
            Search
          </s-button>

          {searchResults.length > 0 && (
            <s-stack gap="small">
              {searchResults.map((product) => (
                <s-clickable key={product.id} onClick={() => loadProduct(product.id)}>
                  <s-box border="base subdued solid" padding="base">
                    <s-stack direction="inline" gap="base" alignItems="center">
                      {product.featuredImage && (
                        <s-thumbnail
                          src={product.featuredImage.url}
                          alt={product.featuredImage.altText || product.title}
                          size="small"
                        />
                      )}
                      <s-text>{product.title}</s-text>
                    </s-stack>
                  </s-box>
                </s-clickable>
              ))}
            </s-stack>
          )}
        </s-stack>
      </s-section>

      {selectedProduct && (
        <>
          <s-section heading="Selected product">
            <s-stack gap="small">
              <s-heading>{selectedProduct.title}</s-heading>
              <s-text color="subdued">
                {selectedProduct.images.length} image
                {selectedProduct.images.length === 1 ? "" : "s"} available
              </s-text>
              <s-text color="subdued">
                Raw supplier/import description is included as source material for OpenAI.
              </s-text>
            </s-stack>
          </s-section>

          <s-section heading="Optimization">
            <s-stack gap="base">
              <s-text-area
                label="Trusted spec source URLs"
                value={trustedSpecSources}
                rows={3}
                placeholder="Optional: one trusted URL per line"
                onInput={(event: any) => setTrustedSpecSources(event.currentTarget.value)}
              />
              <s-text color="subdued">
                Image optimization is limited to 1 image per run while testing.
              </s-text>
              <s-button
                variant="primary"
                loading={optimizing}
                disabled={optimizing}
                onClick={optimizeProduct}
              >
                {optimizing ? "Optimizing..." : "Optimize full product"}
              </s-button>
            </s-stack>
          </s-section>

          {optimizationResult?.verification && (
            <s-section heading="Spec verification">
              <s-stack gap="small">
                <s-badge
                  tone={
                    optimizationResult.verification.confidence === "high"
                      ? "success"
                      : optimizationResult.verification.confidence === "medium"
                        ? "warning"
                        : "critical"
                  }
                >
                  Confidence: {optimizationResult.verification.confidence}
                </s-badge>
                {optimizationResult.verification.merchantReviewNeeded && (
                  <s-banner tone="warning">
                    Merchant review is recommended before saving exact specs or compatibility claims.
                  </s-banner>
                )}
                <s-text color="subdued">
                  Facts used:{" "}
                  {optimizationResult.verification.verifiedFactsUsed?.join("; ") || "None"}
                </s-text>
                <s-text color="subdued">
                  Claims avoided:{" "}
                  {optimizationResult.verification.unsafeClaimsAvoided?.join("; ") || "None"}
                </s-text>
                {optimizationResult.mediaUpload?.uploaded > 0 && (
                  <s-text color="subdued">
                    Uploaded {optimizationResult.mediaUpload.uploaded} optimized image
                    {optimizationResult.mediaUpload.uploaded === 1 ? "" : "s"} to Shopify media.
                  </s-text>
                )}
              </s-stack>
            </s-section>
          )}

          <s-section heading="Generated content">
            <s-stack gap="base">
              <s-text-area
                label="Product description"
                rows={4}
                value={content.productDescriptionHtml}
                onInput={(event: any) =>
                  setContent((prev) => ({
                    ...prev,
                    productDescriptionHtml: event.currentTarget.value,
                  }))
                }
              />
              <s-text-area
                label="Highlights"
                rows={3}
                value={content.description}
                onInput={(event: any) =>
                  setContent((prev) => ({ ...prev, description: event.currentTarget.value }))
                }
              />
              <s-text-area
                label="Key features"
                rows={8}
                value={content.keyFeatures}
                onInput={(event: any) =>
                  setContent((prev) => ({ ...prev, keyFeatures: event.currentTarget.value }))
                }
              />
              <s-text-area
                label="What's in the box"
                rows={5}
                value={content.whatsInTheBox}
                onInput={(event: any) =>
                  setContent((prev) => ({ ...prev, whatsInTheBox: event.currentTarget.value }))
                }
              />
              <s-text-area
                label="Compatibility"
                rows={6}
                value={content.compatibility}
                onInput={(event: any) =>
                  setContent((prev) => ({ ...prev, compatibility: event.currentTarget.value }))
                }
              />
              <s-text-area
                label="FAQs"
                rows={10}
                value={content.faqs}
                onInput={(event: any) =>
                  setContent((prev) => ({ ...prev, faqs: event.currentTarget.value }))
                }
              />
            </s-stack>
          </s-section>

          <s-section heading="SEO and organization">
            <s-stack gap="base">
              <s-text-field
                label="SEO title"
                value={content.seoTitle}
                onInput={(event: any) =>
                  setContent((prev) => ({ ...prev, seoTitle: event.currentTarget.value }))
                }
              />
              <s-text-area
                label="SEO description"
                rows={3}
                value={content.seoDescription}
                onInput={(event: any) =>
                  setContent((prev) => ({
                    ...prev,
                    seoDescription: event.currentTarget.value,
                  }))
                }
              />
              <s-text-field
                label="Product type"
                value={content.productType}
                onInput={(event: any) =>
                  setContent((prev) => ({ ...prev, productType: event.currentTarget.value }))
                }
              />
              <s-text-area
                label="Tags"
                rows={2}
                value={content.tags}
                onInput={(event: any) =>
                  setContent((prev) => ({ ...prev, tags: event.currentTarget.value }))
                }
              />
              <s-button
                variant="primary"
                loading={saveFetcher.state !== "idle"}
                disabled={saveFetcher.state !== "idle"}
                onClick={saveContent}
              >
                Save content to product
              </s-button>
            </s-stack>
          </s-section>
        </>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
