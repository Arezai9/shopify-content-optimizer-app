import type { ActionFunctionArgs } from "react-router";

import {
  fetchTrustedSpecSources,
  generateProductContent,
  optimizeOneImage,
  type ProductForOptimization,
} from "../models/aiProductOptimizer.server";
import { authenticate } from "../shopify.server";

const UPDATE_PRODUCT_WITH_MEDIA_MUTATION = `#graphql
  mutation UpdateProductWithNewMedia($product: ProductUpdateInput!, $media: [CreateMediaInput!]) {
    productUpdate(product: $product, media: $media) {
      product {
        id
        media(first: 20) {
          nodes {
            id
            alt
            mediaContentType
            preview {
              status
            }
          }
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

async function uploadImagesToShopify(
  admin: Awaited<ReturnType<typeof authenticate.admin>>["admin"],
  product: ProductForOptimization,
  imageResults: Array<Record<string, any>>,
) {
  const successfulImages = imageResults.filter(
    (image) => image.optimizedImageUrl && !image.error,
  );

  if (successfulImages.length === 0) {
    return {
      attempted: false,
      uploaded: 0,
      note: "No optimized images were available to upload.",
    };
  }

  const media = successfulImages.map((image, index) => ({
    originalSource: image.optimizedImageUrl,
    mediaContentType: "IMAGE",
    alt: `${product.title || "Product"} optimized image ${index + 1}`,
  }));

  const response = await admin.graphql(UPDATE_PRODUCT_WITH_MEDIA_MUTATION, {
    variables: {
      product: { id: product.id },
      media,
    },
  });
  const responseJson = await response.json();
  const userErrors = responseJson.data?.productUpdate?.userErrors || [];

  return {
    attempted: true,
    uploaded: userErrors.length === 0 ? media.length : 0,
    errors: userErrors,
    media: responseJson.data?.productUpdate?.product?.media?.nodes || [],
  };
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const publicBaseUrl = new URL(request.url).origin;

  try {
    const body = await request.json();
    const product = body.product as ProductForOptimization | undefined;

    if (!product?.id) {
      return Response.json({ error: "Missing product." }, { status: 400 });
    }

    const trustedSpecSources = await fetchTrustedSpecSources(
      body.trustedSpecSourceUrls || [],
    );
    const content = await generateProductContent(product, trustedSpecSources);

    const imageResults = [];
    const optimizeImages = body.optimizeImages !== false;
    const applyAiImageEdit = body.applyAiImageEdit !== false;
    const maxImages = Math.min(Number(body.maxImages || 6), 10);

    if (optimizeImages && Array.isArray(product.images)) {
      for (const image of product.images.slice(0, maxImages)) {
        const imageUrl = image.url || image.src;
        if (!imageUrl) continue;

        try {
          const optimized = await optimizeOneImage({
            imageUrl,
            productTitle: product.title || "",
            publicBaseUrl,
            applyAiEdit: applyAiImageEdit,
          });

          imageResults.push({
            imageId: image.id || null,
            originalImageUrl: imageUrl,
            ...optimized,
          });
        } catch (error) {
          imageResults.push({
            imageId: image.id || null,
            originalImageUrl: imageUrl,
            error: error instanceof Error ? error.message : "Image failed.",
          });
        }
      }
    }

    let mediaUpload;

    if (body.uploadImagesToShopify !== false) {
      try {
        mediaUpload = await uploadImagesToShopify(admin, product, imageResults);
      } catch (error) {
        mediaUpload = {
          attempted: true,
          uploaded: 0,
          error:
            error instanceof Error
              ? error.message
              : "Shopify media upload failed.",
        };
      }
    } else {
      mediaUpload = {
        attempted: false,
        uploaded: 0,
        note: "Shopify media upload skipped by request.",
      };
    }

    return Response.json({
      success: true,
      content,
      verification: content.verification,
      trustedSpecSources: trustedSpecSources.map((source) => ({
        url: source.url,
        ok: source.ok,
        error: source.error,
        contentType: source.contentType,
      })),
      images: imageResults,
      mediaUpload,
    });
  } catch (error) {
    console.error("Full product optimization failed:", error);
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Full product optimization failed.",
      },
      { status: 500 },
    );
  }
};
