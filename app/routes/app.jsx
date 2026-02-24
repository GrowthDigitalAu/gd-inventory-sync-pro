import { Outlet, useLoaderData, useRouteError, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { AppProvider as PolarisAppProvider } from "@shopify/polaris";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import enTranslations from "@shopify/polaris/locales/en.json";
import { authenticate } from "../shopify.server";
import customStyles from "../custom.css?url";

export const links = () => [{ rel: "stylesheet", href: polarisStyles }, { rel: "stylesheet", href: customStyles }];

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData();
  const navigation = useNavigation();
  const isLoading = navigation.state !== "idle";

  return (
    <AppProvider embedded apiKey={apiKey}>
      {isLoading && <div className="loading-bar" />}
      <s-app-nav>
        <s-link href="/app" rel="home">GD: Inventory Sync Pro</s-link>
        <s-link href="/app/products">Get Products</s-link>
        <s-link href="/app/import-product-data">Import Product Inventory Data</s-link>
        <s-link href="/app/export-product-data">Export Product Inventory Data</s-link>
        <s-link href="/app/how-to-use">How To Use</s-link>
      </s-app-nav>
      <PolarisAppProvider i18n={enTranslations}>
        <Outlet />
      </PolarisAppProvider>
    </AppProvider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
