export default function HowToUse() {
    return (
        <s-page heading="Help Center" inlineSize="large">
            <div className="page-frame">
                <div className="help-layout">
                    <div className="primary-workspace">
                        <s-section heading="Import supplier inventory">
                            <div className="help-steps">
                                <div className="help-step">
                                    <span>1</span>
                                    <div>
                                        <strong>Choose a Shopify location</strong>
                                        <p>Select the location that should receive the supplier stock quantities.</p>
                                    </div>
                                </div>
                                <div className="help-step">
                                    <span>2</span>
                                    <div>
                                        <strong>Upload the supplier file</strong>
                                        <p>Use an Excel or CSV file from the supplier or wholesaler.</p>
                                    </div>
                                </div>
                                <div className="help-step">
                                    <span>3</span>
                                    <div>
                                        <strong>Map columns</strong>
                                        <p>Pick the supplier column for SKU and the column for stock quantity.</p>
                                    </div>
                                </div>
                                <div className="help-step">
                                    <span>4</span>
                                    <div>
                                        <strong>Preview and update</strong>
                                        <p>Review matched, skipped, and failed rows before updating Shopify.</p>
                                    </div>
                                </div>
                            </div>
                        </s-section>

                        <div className="section-gap">
                            <s-section heading="Export inventory">
                                <div className="help-card-grid">
                                    <div className="help-card">
                                        <strong>Use it as a backup</strong>
                                        <p>Export current inventory before a large supplier update.</p>
                                    </div>
                                    <div className="help-card">
                                        <strong>Use it as a template</strong>
                                        <p>The export includes SKU, location, and quantity columns.</p>
                                    </div>
                                    <div className="help-card">
                                        <strong>Keep SKU unchanged</strong>
                                        <p>Shopify variants are matched by SKU during import.</p>
                                    </div>
                                </div>
                            </s-section>
                        </div>

                        <div className="section-gap">
                            <s-section heading="File rules">
                                <div className="help-card-grid">
                                    <div className="help-card">
                                        <strong>SKU is required</strong>
                                        <p>Rows without a SKU cannot be matched to Shopify.</p>
                                    </div>
                                    <div className="help-card">
                                        <strong>Quantity must be a number</strong>
                                        <p>Use whole numbers like 0, 12, or 250.</p>
                                    </div>
                                    <div className="help-card">
                                        <strong>Location is selected in the app</strong>
                                        <p>The supplier file does not need a location column.</p>
                                    </div>
                                </div>
                            </s-section>
                        </div>
                    </div>

                    <aside className="growth-aside" aria-label="Help and support">
                        <s-section heading="Support">
                            <div className="growth-panel">
                                <div className="growth-brand">
                                    <span className="growth-brand-icon" aria-hidden="true">GD</span>
                                    <p className="growth-kicker">Growth Digital</p>
                                </div>
                                <p className="growth-title">Need help with a supplier file?</p>
                                <p className="panel-copy">Send the store name, supplier file, and what should happen.</p>
                                <div className="growth-list">
                                    <span>dev@growthdigital.com.au</span>
                                    <span>Supplier feed setup</span>
                                    <span>Inventory import support</span>
                                </div>
                                <a className="growth-link" href="mailto:dev@growthdigital.com.au">Email support</a>
                            </div>
                        </s-section>
                    </aside>
                </div>
            </div>
        </s-page>
    );
}
