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
            <p className="eyebrow">Bulk Shopify inventory</p>
            <h2>Export, preview, update, and recover inventory quantities with a safer workflow.</h2>
            <p className="panel-copy">Work from Excel or CSV files, select one location or all locations, preview changes before Shopify is updated, and keep rollback files for recovery.</p>
          </div>
          <div className="hero-actions">
            <s-link href="/app/import-product-data">Start import</s-link>
            <s-link href="/app/export-product-data">Export backup</s-link>
          </div>
        </div>

        <div className="action-grid two-columns">
          <s-section heading="Import Inventory">
            <div className="action-panel">
              <p className="panel-copy">Load a workbook with SKU and Quantity Available columns, preview quantity changes, then update Shopify in bulk.</p>
              <div className="feature-list">
                <span>Preview before update</span>
                <span>Rollback workbook</span>
                <span>CSV and Excel files</span>
              </div>
              <s-link href="/app/import-product-data">Open import</s-link>
            </div>
          </s-section>
          <s-section heading="Export Inventory">
            <div className="action-panel">
              <p className="panel-copy">Download current inventory quantities by SKU, option values, and inventory location.</p>
              <div className="feature-list">
                <span>All or one location</span>
                <span>Clean import template</span>
                <span>Backup before changes</span>
              </div>
              <s-link href="/app/export-product-data">Open export</s-link>
            </div>
          </s-section>
        </div>

        <div className="section-gap">
          <div className="action-grid three-columns">
            <s-section heading="Safer Updates">
              <div className="action-panel compact">
                <p className="panel-copy">Inventory changes are validated before the update so missing SKUs, invalid quantities, duplicates, and location mismatches are visible first.</p>
              </div>
            </s-section>
            <s-section heading="Location Control">
              <div className="action-panel compact">
                <p className="panel-copy">Update one Shopify location, or use the Inventory Location column when a file covers all locations.</p>
              </div>
            </s-section>
            <s-section heading="Recovery Files">
              <div className="action-panel compact">
                <p className="panel-copy">Download rollback rows from the preview so the old quantities are available if a supplier file needs to be reversed.</p>
              </div>
            </s-section>
          </div>
        </div>
      </div>
    </s-page>
  );
}
