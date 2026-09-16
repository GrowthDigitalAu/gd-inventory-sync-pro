import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};

export default function Index() {
  return (
    <s-page heading="Inventory Sync Pro" inlineSize="large">
      <div className="page-frame">
        <div className="dashboard-hero">
          <div>
            <h2>Update Shopify inventory from a supplier file.</h2>
            <p className="panel-copy">Upload an Excel or CSV file, map the SKU and stock columns, choose a location, and preview before updating.</p>
          </div>
        </div>

        <div className="action-grid two-columns">
          <s-section heading="Import supplier inventory">
            <div className="action-panel">
              <p className="panel-copy">Use this when a supplier or wholesaler sends a stock file.</p>
              <s-link href="/app/import-product-data">Open import</s-link>
            </div>
          </s-section>
          <s-section heading="Export current inventory">
            <div className="action-panel">
              <p className="panel-copy">Download a backup of current Shopify inventory before a large update.</p>
              <s-link href="/app/export-product-data">Open export</s-link>
            </div>
          </s-section>
        </div>
      </div>
    </s-page>
  );
}
