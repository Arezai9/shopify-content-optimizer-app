import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export default function Index() {
  return (
    <s-page heading="Rezar AI Product Optimizer">
      <s-section heading="Product content and image optimization">
        <s-stack gap="base">
          <s-paragraph>
            Generate product content, verify specs from trusted sources, use raw supplier descriptions as source material, clean product images,
            and upload optimized media back to Shopify.
          </s-paragraph>
          <s-button href="/app/product-optimizer" variant="primary">
            Open product optimizer
          </s-button>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="What it updates">
        <s-unordered-list>
          <s-list-item>Product description, SEO, product type, and tags</s-list-item>
          <s-list-item>Custom rich-text metafields for highlights, features, box contents, compatibility, and FAQs</s-list-item>
          <s-list-item>Optimized square product media when image optimization is enabled</s-list-item>
        </s-unordered-list>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
