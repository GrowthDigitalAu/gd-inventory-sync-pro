import { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import ExcelJS from "exceljs";
import { useAppBridge } from "@shopify/app-bridge-react";
import { ProgressBar } from "@shopify/polaris";


export const loader = async ({ request }) => {
    const { admin } = await authenticate.admin(request);
    const url = new URL(request.url);
    const checkStatus = url.searchParams.get("checkStatus");
    const locationId = url.searchParams.get("locationId");
    const operationId = url.searchParams.get("operationId");

    if (checkStatus === "true" && operationId) {
        // Query specific Bulk Operation by ID to avoid stale data
        const response = await admin.graphql(
            `#graphql
            query($id: ID!) {
                node(id: $id) {
                    ... on BulkOperation {
                        id
                        status
                        errorCode
                        createdAt
                        completedAt
                        objectCount
                        fileSize
                        url
                        partialDataUrl
                    }
                }
            }`,
            { variables: { id: operationId } }
        );

        const data = await response.json();
        const bulkOperation = data.data?.node;

        if (!bulkOperation) {
            return { success: false, status: "NONE", operationId };
        }

        if (bulkOperation.status === "COMPLETED") {
            try {
                if (!bulkOperation.url) {
                     return { success: false, status: "FAILED", error: "No URL in completed bulk operation", operationId };
                }
                const response = await fetch(bulkOperation.url);
                const text = await response.text();
                const lines = text.split("\n").filter(line => line.trim() !== "");

                const productsMap = new Map();
                const variantsMap = new Map();
                const inventoryItemsMap = new Map();
                
                const products = [];

                lines.forEach(line => {
                    try {
                        const obj = JSON.parse(line);
                        
                        if (obj.id && obj.id.includes("Product") && !obj.sku) {
                             obj.variants = [];
                             productsMap.set(obj.id, obj);
                             products.push(obj);
                        } else if (obj.id && obj.id.includes("ProductVariant")) {
                            variantsMap.set(obj.id, obj);
                            
                            const parentId = obj.__parentId;
                            if (parentId && productsMap.has(parentId)) {
                                productsMap.get(parentId).variants.push(obj);
                            }

                            // Ensure inventoryItem exists and init array
                            if (obj.inventoryItem) {
                                obj.inventoryItem.inventoryLevels = [];
                                // Map InventoryItem ID
                                inventoryItemsMap.set(obj.inventoryItem.id, obj.inventoryItem);
                            }
                        } else if ((obj.id && obj.id.includes("InventoryLevel")) || (obj.location && obj.quantities)) {
                            // Identified as InventoryLevel
                            const parentId = obj.__parentId;
                            
                            // Try linking to InventoryItem (Standard expectation)
                            if (parentId && inventoryItemsMap.has(parentId)) {
                                inventoryItemsMap.get(parentId).inventoryLevels.push(obj);
                            } 
                            // Fallback: Try linking to ProductVariant (If InventoryItem is skipped as node)
                            else if (parentId && variantsMap.has(parentId)) {
                                const variant = variantsMap.get(parentId);
                                if (variant.inventoryItem) {
                                    if (!variant.inventoryItem.inventoryLevels) {
                                        variant.inventoryItem.inventoryLevels = [];
                                    }
                                    variant.inventoryItem.inventoryLevels.push(obj);
                                }
                            }
                        }
                    } catch (e) {
                        console.error("Error parsing line", e);
                    }
                });

                 const rows = [];
                 products.forEach(product => {
                     // If location filtering is active, we check if the PRODUCT has any relevant inventory
                     // But we must iterate variants to find out.
                     if (!product.variants || product.variants.length === 0) return;

                     product.variants.forEach(variant => {
                         const options = {};
                         options["Option1 Value"] = "";
                         options["Option2 Value"] = "";
                         options["Option3 Value"] = "";

                         if (variant.selectedOptions) {
                             variant.selectedOptions.forEach((opt, index) => {
                                 if (index < 3) {
                                     options[`Option${index + 1} Value`] = opt.value;
                                 }
                             });
                         }

                         const inventoryItem = variant.inventoryItem;
                         const inventoryLevels = inventoryItem?.inventoryLevels || [];

                         const filteredInventory = (locationId && locationId !== "ALL_LOCATIONS")
                             ? inventoryLevels.filter(level => level.location.id === locationId)
                             : inventoryLevels;

                         if (filteredInventory.length === 0) {
                             if (!locationId || locationId === "ALL_LOCATIONS") {
                                 rows.push({
                                     "Product Title": product.title,
                                     "SKU": variant.sku || "",
                                     "Option1 Value": options["Option1 Value"],
                                     "Option2 Value": options["Option2 Value"],
                                     "Option3 Value": options["Option3 Value"],
                                     "Inventory Location": "N/A",
                                     "Quantity Available": 0
                                 });
                             }
                         } else {
                             filteredInventory.forEach(level => {
                                 rows.push({
                                     "Product Title": product.title,
                                     "SKU": variant.sku || "",
                                     "Option1 Value": options["Option1 Value"],
                                     "Option2 Value": options["Option2 Value"],
                                     "Option3 Value": options["Option3 Value"],
                                     "Inventory Location": level.location?.name || "Unknown",
                                     "Quantity Available": level.quantities[0]?.quantity || 0
                                 });
                             });
                         }
                     });
                 });
                 
                 if (rows.length === 0) {
                     rows.push({
                         "Product Title": "No data found",
                         "SKU": "",
                         "Option1 Value": "",
                         "Option2 Value": "",
                         "Option3 Value": "",
                         "Inventory Location": "",
                         "Quantity Available": ""
                     });
                 }

                 return { success: true, status: "COMPLETED", rows, operationId };

            } catch (error) {
                console.error("Error parsing bulk data:", error);
                return { success: false, status: "FAILED", error: "Failed to parse bulk data", operationId };
            }
        } else if (bulkOperation.status === "RUNNING" || bulkOperation.status === "CREATED") {
             return { success: true, status: "RUNNING", progress: bulkOperation.objectCount, operationId };
        } else {
             return { success: false, status: bulkOperation.status, operationId };
        }
    }

    const response = await admin.graphql(
        `#graphql
        query getLocations {
            locations(first: 250, includeLegacy: true, includeInactive: true) {
                edges {
                    node {
                        id
                        name
                        isActive
                    }
                }
            }
        }`
    );

    const data = await response.json();
    const locations = data.data?.locations?.edges.map(edge => ({
        id: edge.node.id,
        name: edge.node.name,
        isActive: edge.node.isActive
    })) || [];

    return { locations };
};

export const action = async ({ request }) => {
    const { admin } = await authenticate.admin(request);
    const formData = await request.formData();
    const locationId = formData.get("locationId");

    // Helper to cancel operation
    const cancelOperation = async (id) => {
        try {
            await admin.graphql(
                `#graphql
                mutation {
                    bulkOperationCancel(id: "${id}") {
                        bulkOperation { status }
                        userErrors { field message }
                    }
                }`
            );
            // Increased wait time for robustness
            await new Promise(resolve => setTimeout(resolve, 3000));
        } catch (e) {
            console.error("Error canceling operation", e);
        }
    };

    const currentOpResponse = await admin.graphql(
        `#graphql
        query {
            currentBulkOperation {
                id
                status
            }
        }`
    );
    const currentOpData = await currentOpResponse.json();
    const currentOp = currentOpData.data?.currentBulkOperation;

    if (currentOp && currentOp.status !== "COMPLETED") {
         await cancelOperation(currentOp.id);
    }
    
    // 2. Try to run the query
    const runQuery = async () => {
         const response = await admin.graphql(
            `#graphql
            mutation {
                bulkOperationRunQuery(
                query: """
                    {
                        products {
                            edges {
                                node {
                                    id
                                    title
                                    variants {
                                        edges {
                                            node {
                                                id
                                                sku
                                                selectedOptions {
                                                    name
                                                    value
                                                }
                                                inventoryItem {
                                                    id
                                                    inventoryLevels {
                                                        edges {
                                                            node {
                                                                id
                                                                location {
                                                                    id
                                                                    name
                                                                }
                                                                quantities(names: ["available"]) {
                                                                    quantity
                                                                }
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                """
                ) {
                    bulkOperation {
                        id
                        status
                    }
                    userErrors {
                        field
                        message
                    }
                }
            }`
        );
        return await response.json();
    };

    let result = await runQuery();

    // 3. Retry logic if it still says "in progress"
    if (result.data?.bulkOperationRunQuery?.userErrors?.some(e => e.message.includes("in progress"))) {
         const retryOpResponse = await admin.graphql(`{ currentBulkOperation { id } }`);
         const retryOpData = await retryOpResponse.json();
         if (retryOpData.data?.currentBulkOperation?.id) {
             await cancelOperation(retryOpData.data.currentBulkOperation.id);
         }
         // Retry once
         result = await runQuery();
    }

    if (result.data?.bulkOperationRunQuery?.userErrors?.length > 0) {
        return { success: false, error: result.data.bulkOperationRunQuery.userErrors[0].message };
    }

    return { success: true, status: "CREATED", locationId, operationId: result.data.bulkOperationRunQuery.bulkOperation.id };
};

export default function ExportProductData() {
    const shopify = useAppBridge();
    const fetcher = useFetcher();
    const loaderFetcher = useFetcher();
    const pollFetcher = useFetcher();
    
    const [selectedLocation, setSelectedLocation] = useState("SELECT_LOCATION");
    const [progress, setProgress] = useState(0);
    const [isProgressVisible, setIsProgressVisible] = useState(false);
    
    const [currentExport, setCurrentExport] = useState(null);

    const [isStylesLoaded, setIsStylesLoaded] = useState(false);

    useEffect(() => {
        const timer = setTimeout(() => {
            setIsStylesLoaded(true);
        }, 100);
        return () => clearTimeout(timer);
    }, []);


    const isLoading = fetcher.state === "submitting" || fetcher.state === "loading" || !!currentExport;
    const locations = loaderFetcher.data?.locations || [];

    useEffect(() => {
        loaderFetcher.load("/app/export-product-data");
    }, []);

    // Start Polling (Triggered by successful action)
    useEffect(() => {
        if (fetcher.data?.success && fetcher.data?.status === "CREATED") {
            const opId = fetcher.data.operationId;
            const locId = fetcher.data.locationId;
            
            // Set the ACTIVE export state
            setCurrentExport({ operationId: opId, locationId: locId });
            
            setIsProgressVisible(true);
            setProgress(0);
            shopify.toast.show("Export started...", { duration: 5000 });
            
            // Immediate check
            pollFetcher.load(`/app/export-product-data?checkStatus=true&locationId=${locId}&operationId=${opId}`);
        } else if (fetcher.data?.error) {
            shopify.toast.show(fetcher.data.error, { duration: 5000 });
            setIsProgressVisible(false);
        }
    }, [fetcher.data]);

    // Handle Polling Loop
    useEffect(() => {
        if (currentExport) {
            const { operationId, locationId } = currentExport;

            // Strict check: Only process data if it matches the current Operation ID
            if (pollFetcher.data && pollFetcher.data.operationId === operationId) {

                if (pollFetcher.data?.status === "RUNNING") {
                    const timer = setTimeout(() => {
                        pollFetcher.load(`/app/export-product-data?checkStatus=true&locationId=${locationId}&operationId=${operationId}`);
                    }, 2000);
                    return () => clearTimeout(timer);

                } else if (pollFetcher.data?.status === "COMPLETED") {
                    setCurrentExport(null); // Stop polling
                    setProgress(100);
                    
                    const rows = pollFetcher.data.rows;
                    const workbook = new ExcelJS.Workbook();
                    const worksheet = workbook.addWorksheet("Products");

                    if (rows.length > 0) {
                        worksheet.addRow(Object.keys(rows[0]));
                        rows.forEach(row => worksheet.addRow(Object.values(row)));
                    }

                    workbook.xlsx.writeBuffer().then(buffer => {
                        const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement("a");
                        a.href = url;
                        a.download = "products_export.xlsx";
                        a.click();
                        URL.revokeObjectURL(url);
                        shopify.toast.show("Export complete", { duration: 5000 });
                        
                        const timeout = setTimeout(() => {
                            setIsProgressVisible(false);
                        }, 500);
                        return () => clearTimeout(timeout);

                    }).catch(err => {
                        console.error(err);
                        shopify.toast.show("Export failed generation", { duration: 5000 });
                        setIsProgressVisible(false);
                    });
                    
                } else if (pollFetcher.data?.status === "FAILED" || pollFetcher.data?.status === "NONE") {
                    setCurrentExport(null);
                    setIsProgressVisible(false);
                    shopify.toast.show("Export failed: " + (pollFetcher.data?.error || "Unknown error"), { duration: 5000 });
                }
            }
        }
    }, [pollFetcher.data, currentExport]);


    // Fake progress animation
    useEffect(() => {
        if (isProgressVisible && currentExport) {
            const interval = setInterval(() => {
                setProgress((prev) => {
                    // Gradual increments to avoid "rushing" to 90%
                    if (prev < 30) return prev + 5; 
                    if (prev < 60) return prev + 2; 
                    if (prev < 90) return prev + 1; 
                    return prev;
                });
            }, 800);
            return () => clearInterval(interval);
        }
    }, [isProgressVisible, currentExport]);


    const handleExport = () => {
        if (!selectedLocation || selectedLocation === "SELECT_LOCATION") {
            shopify.toast.show("Choose a location before exporting.", { duration: 5000 });
            return;
        }
        setProgress(0);
        setIsProgressVisible(true);
        fetcher.submit(
            { locationId: selectedLocation },
            { method: "POST" }
        );
    };

    if (!isStylesLoaded) {
        return null;
    }

    return (
        <s-page heading="Export Product Inventory Data" inlineSize="large">
            <div className="page-frame">
                <div className="app-layout-with-aside">
                    <div className="primary-workspace">
                        <s-section heading="Download Inventory Workbook">
                            <div className="source-panel">
                                <div className="source-copy">
                                    <p className="panel-title">Current Shopify inventory quantities</p>
                                    <p className="panel-copy">Export product title, SKU, option values, inventory location, and available quantity into an Excel workbook.</p>
                                    <div className="file-meta">
                                        <span>Format: .xlsx</span>
                                        <span>{selectedLocation === "ALL_LOCATIONS" ? "All locations" : "Single location"}</span>
                                    </div>
                                </div>
                                <div className="source-actions">
                                    <s-select
                                        className="export-select-dropdown"
                                        label="Choose Location"
                                        value={selectedLocation}
                                        onChange={(e) => setSelectedLocation(e.target.value)}
                                    >
                                        <s-option value="SELECT_LOCATION" disabled>- Select -</s-option>
                                        <s-option value="ALL_LOCATIONS">All Locations</s-option>
                                        <s-option-group label="Available Store Locations">
                                            {locations.map((location) => (
                                                <s-option key={location.id} value={location.id}>
                                                    {location.name}
                                                </s-option>
                                            ))}
                                        </s-option-group>
                                    </s-select>
                                    <s-button
                                        variant="primary"
                                        onClick={handleExport}
                                        loading={isLoading ? "true" : undefined}
                                        disabled={!selectedLocation || selectedLocation === "SELECT_LOCATION" ? "true" : undefined}
                                    >
                                        Export Inventory
                                    </s-button>
                                </div>
                            </div>
                        </s-section>

                        <div className="section-gap">
                            <div className="action-grid three-columns">
                                <s-section heading="Included Columns">
                                    <div className="action-panel compact">
                                        <p className="panel-copy">Product title, SKU, option values, inventory location, and quantity available.</p>
                                    </div>
                                </s-section>
                                <s-section heading="Best Use">
                                    <div className="action-panel compact">
                                        <p className="panel-copy">Export before a major inventory update to keep a clean backup and import-ready template.</p>
                                    </div>
                                </s-section>
                                <s-section heading="Next Workflow">
                                    <div className="action-panel compact">
                                        <p className="panel-copy">Edit Quantity Available values, keep SKU unchanged, then use the import preview before updating Shopify.</p>
                                    </div>
                                </s-section>
                            </div>
                        </div>
                    </div>

                    <aside className="growth-aside" aria-label="Growth Digital Shopify support">
                        <s-section heading="Export Tips">
                            <div className="growth-panel">
                                <div className="growth-brand">
                                    <span className="growth-brand-icon" aria-hidden="true">GD</span>
                                    <p className="growth-kicker">Growth Digital</p>
                                </div>
                                <p className="growth-title">Use exports as your backup before every bulk change.</p>
                                <p className="panel-copy">The exported workbook matches the import flow, so it is the safest starting point for quantity updates.</p>
                                <div className="growth-list">
                                    <span>Keep SKU unchanged</span>
                                    <span>Edit Quantity Available</span>
                                    <span>Preview before import</span>
                                </div>
                            </div>
                        </s-section>
                    </aside>
                </div>
            </div>

            {isProgressVisible && (
                <div className="progress-float">
                    <ProgressBar progress={progress} size="small" />
                    <s-text variant="bodyLg">Exporting product inventory...</s-text>
                </div>
            )}
        </s-page>
    );
}
